#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

//! Agent child-process supervision (P3-2, ADR-0002 decision 2 / spike S2 route a).
//!
//! [`AgentProcess`] starts an agent with piped stdio and keeps its **whole process tree** under
//! AgentDock's control: on Windows inside a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
//! (`process-wrap` sets that flag only when `KillOnDrop` is also wrapped), on Unix as the leader
//! of a new process group. Unsafe code stays inside `process-wrap`.
//!
//! Known Unix gap: if AgentDock itself is SIGKILLed, the process group is not killed (that would
//! need `PR_SET_PDEATHSIG`, out of scope for alpha). On Windows the kernel closes the Job handle
//! and kills the tree.

pub mod env;
mod stderr_tail;

use std::any::Any;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::Duration;

use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use tokio::io::AsyncReadExt;
use tokio::process::{ChildStdin, ChildStdout};
use tokio::task::JoinHandle;

use stderr_tail::StderrTail;
pub use stderr_tail::STDERR_TAIL_CAP;

/// Maximum characters per argument.
pub const MAX_ARG_CHARS: usize = 4096;

#[derive(Clone)]
pub struct AgentCommand {
    /// Absolute; on Windows must not end in `.cmd` / `.bat` / `.ps1` (case-insensitive).
    pub program: PathBuf,
    /// Each at most [`MAX_ARG_CHARS`] characters, no NUL.
    pub args: Vec<String>,
    /// Caller passes a path already checked by `agentdock-policy` (P4-1).
    pub cwd: PathBuf,
    /// Names only, `^[A-Z_][A-Z0-9_]{0,63}$`; values are copied from the host environment.
    pub auth_env_names: Vec<String>,
    /// Non-secret pairs, e.g. `NO_COLOR=1`.
    pub extra_env: Vec<(String, String)>,
}

/// Prints only the program's file name, the argument count and environment variable *names*:
/// arguments, `cwd` and `extra_env` values may carry user paths or tokens.
impl std::fmt::Debug for AgentCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let extra_names: Vec<&str> = self.extra_env.iter().map(|(n, _)| n.as_str()).collect();
        f.debug_struct("AgentCommand")
            .field("program", &self.program.file_name().unwrap_or_default())
            .field("args_len", &self.args.len())
            .field("auth_env_names", &self.auth_env_names)
            .field("extra_env_names", &extra_names)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ShutdownTimeouts {
    pub stdin_grace: Duration,
    pub term_grace: Duration,
}

impl Default for ShutdownTimeouts {
    /// PR #25 `DEFAULT_LIMITS`: `stdinGraceMs: 1500`, `killGraceMs: 3000`.
    fn default() -> Self {
        Self {
            stdin_grace: Duration::from_millis(1500),
            term_grace: Duration::from_millis(3000),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitKind {
    /// The agent had already ended on its own before `shutdown` started.
    Exited { code: Option<i32> },
    /// The agent exited within `stdin_grace` after stdin was closed.
    ClosedGracefully,
    /// The Job / process group was killed.
    Terminated,
}

#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
    #[error("agent executable must be an absolute path")]
    RelativeProgram,
    #[error("agent executable is a shell shim ({ext}); configure the real executable instead")]
    ShellShim { ext: String },
    #[error("invalid environment variable name")]
    BadEnvName,
    #[error("invalid argument")]
    BadArgument,
    // Never include the command line: it may carry user paths or tokens.
    #[error("could not start agent: {kind:?}")]
    Spawn { kind: std::io::ErrorKind },
    #[error("process supervision unavailable: {0}")]
    Supervision(String),
}

/// Windows shell-shim extension of `file_name`, if any (`cmd`, `bat`, `ps1`), ASCII-lowercased.
///
/// Win32 path normalization drops an NTFS stream suffix (`:...`) and trailing dots and spaces,
/// so `x.cmd.` and `x.CMD ` would still start `x.cmd`; they are rejected too. Pure logic, so it
/// is unit-tested on every platform.
fn shell_shim_ext(file_name: &str) -> Option<String> {
    let base = file_name.split(':').next().unwrap_or(file_name);
    let base = base.trim_end_matches(['.', ' ']);
    let ext = base.rsplit_once('.')?.1.to_ascii_lowercase();
    matches!(ext.as_str(), "cmd" | "bat" | "ps1").then_some(ext)
}

fn validate(cmd: &AgentCommand) -> Result<(), ProcessError> {
    if !cmd.program.is_absolute() {
        return Err(ProcessError::RelativeProgram);
    }
    if cfg!(windows) {
        let name = cmd
            .program
            .file_name()
            .map(OsStr::to_string_lossy)
            .unwrap_or_default();
        if let Some(ext) = shell_shim_ext(&name) {
            return Err(ProcessError::ShellShim { ext });
        }
    }
    if cmd
        .args
        .iter()
        .any(|a| a.contains('\0') || a.chars().count() > MAX_ARG_CHARS)
    {
        return Err(ProcessError::BadArgument);
    }
    Ok(())
}

/// Host environment as UTF-8 pairs; entries that are not valid Unicode are dropped instead of
/// panicking (`std::env::vars` would panic).
fn host_env() -> Vec<(String, String)> {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

fn build_command(cmd: &AgentCommand, env: Vec<(String, String)>, cwd: &Path) -> CommandWrap {
    let mut command = tokio::process::Command::new(&cmd.program);
    command
        .args(&cmd.args)
        .env_clear()
        .envs(env)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut wrap = CommandWrap::from(command);
    #[cfg(windows)]
    {
        use process_wrap::tokio::{CreationFlags, JobObject};
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        wrap.wrap(CreationFlags(CREATE_NO_WINDOW));
        wrap.wrap(JobObject);
    }
    #[cfg(unix)]
    {
        use process_wrap::tokio::ProcessGroup;
        wrap.wrap(ProcessGroup::leader());
    }
    // Required with JobObject: without it process-wrap does not set KILL_ON_JOB_CLOSE.
    wrap.wrap(KillOnDrop);
    wrap
}

/// A supervised agent child process.
pub struct AgentProcess {
    child: Box<dyn ChildWrapper>,
    tail: Arc<StderrTail>,
    stderr_task: Option<JoinHandle<()>>,
    /// Exit code of the direct child once observed (`Some(None)` = killed by a signal).
    exit_code: Option<Option<i32>>,
    /// Result of the first completed `shutdown`.
    outcome: Option<ExitKind>,
}

impl std::fmt::Debug for AgentProcess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately omits the command line, environment and stderr.
        f.debug_struct("AgentProcess")
            .field("pid", &self.child.id())
            .field("outcome", &self.outcome)
            .finish_non_exhaustive()
    }
}

impl AgentProcess {
    /// Validates, then spawns with stdin/stdout/stderr piped, window hidden, inside a
    /// kill-on-close Job (Windows) or a new process group (Unix). Starts the stderr drain task
    /// before returning. Must be called inside a Tokio runtime.
    pub fn spawn(cmd: &AgentCommand) -> Result<Self, ProcessError> {
        validate(cmd)?;
        let env = env::child_env(&host_env(), &cmd.auth_env_names, &cmd.extra_env)?;
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| ProcessError::Supervision("a Tokio runtime is required".into()))?;

        let mut child = build_command(cmd, env, &cmd.cwd)
            .spawn()
            .map_err(|e| match e.kind() {
                // JobObject: the child exposes no process handle (process-wrap already killed it).
                std::io::ErrorKind::Unsupported => ProcessError::Supervision(
                    "child wrapper does not expose a process handle".into(),
                ),
                kind => ProcessError::Spawn { kind },
            })?;

        let tail = Arc::new(StderrTail::new());
        let stderr_task = child.stderr().take().map(|mut stderr| {
            let tail = Arc::clone(&tail);
            runtime.spawn(async move {
                let mut buf = vec![0u8; 8 * 1024];
                loop {
                    match stderr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => tail.push(&buf[..n]),
                    }
                }
            })
        });

        Ok(Self {
            child,
            tail,
            stderr_task,
            exit_code: None,
            outcome: None,
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// Take the pipes once (for P3-1 `framed_lines` / `line_sink`). Second call returns `None`,
    /// as does a call after `shutdown`.
    ///
    /// If the caller holds the returned `ChildStdin`, it must drop it before `shutdown`, or the
    /// agent never sees EOF and is killed after `stdin_grace`.
    pub fn take_stdio(&mut self) -> Option<(ChildStdin, ChildStdout)> {
        if self.child.stdin().is_none() || self.child.stdout().is_none() {
            return None;
        }
        Some((self.child.stdin().take()?, self.child.stdout().take()?))
    }

    /// Last <= 64 KiB of stderr, lossy UTF-8. Caller must redact before showing or storing.
    pub fn stderr_tail(&self) -> String {
        self.tail.snapshot()
    }

    /// Resolves when the direct child exits (descendants may live on; use `shutdown` for the
    /// tree). Like Tokio's `Child::wait`, closes stdin first if it was not taken.
    pub async fn wait(&mut self) -> std::io::Result<Option<i32>> {
        if let Some(code) = self.exit_code {
            return Ok(code);
        }
        let status = self.wait_direct().await?;
        self.exit_code = Some(status.code());
        Ok(status.code())
    }

    /// Orderly: drop stdin, wait `stdin_grace`, kill the whole tree, wait `term_grace`.
    /// Idempotent: a second call returns the first result immediately.
    ///
    /// The whole Job / process group is killed even when the direct child exited on its own,
    /// so launchers that leave the real agent running cannot leak it.
    pub async fn shutdown(&mut self, t: ShutdownTimeouts) -> ExitKind {
        if let Some(kind) = &self.outcome {
            return kind.clone();
        }
        let kind = self.shutdown_inner(t).await;
        self.outcome = Some(kind.clone());
        kind
    }

    async fn shutdown_inner(&mut self, t: ShutdownTimeouts) -> ExitKind {
        let already = match self.exit_code {
            Some(code) => Some(code),
            None => self.try_wait_direct().map(|s| s.code()),
        };
        drop(self.child.stdin().take());
        // Nobody reads stdout any more; an agent blocked on a full stdout pipe gets EPIPE.
        drop(self.child.stdout().take());

        if let Some(code) = already {
            self.exit_code = Some(code);
            self.kill_tree();
            return ExitKind::Exited { code };
        }

        match tokio::time::timeout(t.stdin_grace, self.wait_direct()).await {
            Ok(Ok(status)) => {
                self.exit_code = Some(status.code());
                self.kill_tree();
                ExitKind::ClosedGracefully
            }
            _ => {
                self.kill_tree();
                if let Ok(Ok(status)) = tokio::time::timeout(t.term_grace, self.wait_direct()).await
                {
                    self.exit_code = Some(status.code());
                }
                ExitKind::Terminated
            }
        }
    }

    /// Windows: `TerminateJobObject`; Unix: `SIGKILL` to the process group. Works after the
    /// direct child has exited; errors (e.g. group already empty) are ignored.
    fn kill_tree(&mut self) {
        let _ = self.child.start_kill();
    }

    /// The native Tokio child under the Job / process-group wrapper. The wrappers' own
    /// `wait()` also waits for (Windows) or reaps (Unix) the rest of the tree, which is not
    /// what "direct child exited" means here.
    fn direct_child(&mut self) -> Option<&mut tokio::process::Child> {
        let inner: &mut dyn Any = self.child.inner_mut();
        inner.downcast_mut::<tokio::process::Child>()
    }

    async fn wait_direct(&mut self) -> std::io::Result<ExitStatus> {
        if let Some(child) = self.direct_child() {
            return child.wait().await;
        }
        self.child.wait().await
    }

    fn try_wait_direct(&mut self) -> Option<ExitStatus> {
        if let Some(child) = self.direct_child() {
            return child.try_wait().ok().flatten();
        }
        self.child.try_wait().ok().flatten()
    }
}

impl Drop for AgentProcess {
    /// If `shutdown` did not complete, kill the whole tree now. On Windows dropping the Job
    /// handle (KILL_ON_JOB_CLOSE) would also do it; Tokio's `kill_on_drop` alone only kills
    /// the direct child on Unix, so the group is killed explicitly.
    fn drop(&mut self) {
        if self.outcome.is_none() {
            self.kill_tree();
        }
        if let Some(task) = self.stderr_task.take() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(program: &str) -> AgentCommand {
        AgentCommand {
            program: PathBuf::from(program),
            args: vec![],
            cwd: std::env::temp_dir(),
            auth_env_names: vec![],
            extra_env: vec![],
        }
    }

    #[test]
    fn shim_extension_rules() {
        assert_eq!(
            shell_shim_ext("claude-agent-acp.CMD").as_deref(),
            Some("cmd")
        );
        assert_eq!(shell_shim_ext("x.Bat").as_deref(), Some("bat"));
        assert_eq!(shell_shim_ext("x.ps1").as_deref(), Some("ps1"));
        assert_eq!(shell_shim_ext("x.cmd. .").as_deref(), Some("cmd"));
        assert_eq!(shell_shim_ext("x.cmd::$DATA").as_deref(), Some("cmd"));
        assert_eq!(shell_shim_ext("node.exe"), None);
        assert_eq!(shell_shim_ext("cmd"), None);
        assert_eq!(shell_shim_ext("x.cmdx"), None);
    }

    #[test]
    fn debug_hides_arguments_paths_and_values() {
        let c = AgentCommand {
            program: PathBuf::from("/secret-dir/agent-bin"),
            args: vec!["--token=sk-ant-FAKE".into()],
            cwd: PathBuf::from("/home/someone/project"),
            auth_env_names: vec!["ANTHROPIC_API_KEY".into()],
            extra_env: vec![("NO_COLOR".into(), "value-should-not-print".into())],
        };
        let s = format!("{c:?}");
        assert!(
            s.contains("agent-bin") && s.contains("ANTHROPIC_API_KEY") && s.contains("NO_COLOR")
        );
        for hidden in [
            "secret-dir",
            "sk-ant-FAKE",
            "someone",
            "value-should-not-print",
        ] {
            assert!(!s.contains(hidden), "{hidden} leaked in {s}");
        }
    }

    #[test]
    fn relative_program_is_rejected() {
        assert!(matches!(
            validate(&cmd("node")),
            Err(ProcessError::RelativeProgram)
        ));
    }

    #[test]
    fn bad_arguments_are_rejected() {
        let abs = if cfg!(windows) {
            "C:\\x\\agent.exe"
        } else {
            "/x/agent"
        };
        let mut c = cmd(abs);
        c.args = vec!["a\0b".into()];
        assert!(matches!(validate(&c), Err(ProcessError::BadArgument)));
        c.args = vec!["é".repeat(MAX_ARG_CHARS)];
        assert!(validate(&c).is_ok());
        c.args = vec!["a".repeat(MAX_ARG_CHARS + 1)];
        assert!(matches!(validate(&c), Err(ProcessError::BadArgument)));
    }

    #[test]
    fn spawn_outside_runtime_is_rejected() {
        let program = std::env::current_exe().unwrap();
        let c = AgentCommand {
            program,
            ..cmd("/unused")
        };
        assert!(matches!(
            AgentProcess::spawn(&c),
            Err(ProcessError::Supervision(_))
        ));
    }
}
