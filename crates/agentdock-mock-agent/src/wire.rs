//! Message builders for the mock agent.
//!
//! ACP v1 wire format: field names are camelCase (`sessionId`, `stopReason`, `toolCallId`,
//! `sessionUpdate`), enum values are snake_case (`agent_message_chunk`, `allow_once`,
//! `end_turn`). Names were checked against `agent-client-protocol-schema` 1.21.2.

use serde_json::{json, Value};

pub const SESSION_ID: &str = "mock-session-1";

pub fn result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

pub fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

pub fn initialize_result(protocol_version: u64) -> Value {
    json!({"protocolVersion": protocol_version, "agentCapabilities": {"loadSession": false}, "authMethods": []})
}

/// `initialize` result of the `auth-required` scenario: one advertised auth method.
pub fn initialize_result_with_auth() -> Value {
    json!({"protocolVersion": 1, "agentCapabilities": {"loadSession": false},
           "authMethods": [{"id": "mock-login", "name": "Mock login"}]})
}

pub fn new_session_result() -> Value {
    json!({"sessionId": SESSION_ID})
}

/// `stop_reason` is `"end_turn"` or `"cancelled"`.
pub fn prompt_result(stop_reason: &str) -> Value {
    json!({"stopReason": stop_reason})
}

pub fn text_chunk(text: &str) -> Value {
    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":SESSION_ID,
        "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}})
}

/// Text chunk that also carries a `_meta` extension object (ADR-0002 S5).
pub fn text_chunk_with_meta(text: &str) -> Value {
    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":SESSION_ID,
        "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text},
                  "_meta":{"vendor":"agentdock-mock"}}}})
}

/// A notification whose method the client does not know.
pub fn vendor_ping() -> Value {
    json!({"jsonrpc":"2.0","method":"_vendor/ping","params":{"x":1}})
}

pub fn tool_call(id: &str, title: &str, command: &str) -> Value {
    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":SESSION_ID,
        "update":{"sessionUpdate":"tool_call","toolCallId":id,"title":title,"kind":"execute","status":"pending",
                  "rawInput":{"command":command}}}})
}

/// `status` is `"completed"` or `"failed"`.
pub fn tool_call_done(id: &str, status: &str) -> Value {
    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":SESSION_ID,
        "update":{"sessionUpdate":"tool_call_update","toolCallId":id,"status":status}}})
}

/// Agent -> client request. `req_id` must not collide with client ids; use strings
/// `mock-perm-<n>`.
pub fn request_permission(req_id: &str, tool_call_id: &str, title: &str) -> Value {
    json!({"jsonrpc":"2.0","id":req_id,"method":"session/request_permission","params":{"sessionId":SESSION_ID,
        "toolCall":{"toolCallId":tool_call_id,"title":title},
        "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
                   {"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}})
}

/// Same options as [`request_permission`], but the tool call is an edit with a path (used by
/// `scripted` `EDIT-PATH`).
pub fn request_permission_edit(req_id: &str, tool_call_id: &str, title: &str, path: &str) -> Value {
    json!({"jsonrpc":"2.0","id":req_id,"method":"session/request_permission","params":{"sessionId":SESSION_ID,
        "toolCall":{"toolCallId":tool_call_id,"title":title,"kind":"edit","locations":[{"path":path}]},
        "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
                   {"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_are_camel_case_and_enum_values_snake_case() {
        let chunk = text_chunk("hi");
        assert_eq!(chunk["params"]["sessionId"], SESSION_ID);
        assert_eq!(
            chunk["params"]["update"]["sessionUpdate"],
            "agent_message_chunk"
        );
        assert_eq!(prompt_result("end_turn")["stopReason"], "end_turn");
        let perm = request_permission("mock-perm-1", "call_1", "t");
        assert_eq!(perm["params"]["options"][0]["optionId"], "allow-once");
        assert_eq!(perm["params"]["options"][0]["kind"], "allow_once");
        assert_eq!(perm["params"]["toolCall"]["toolCallId"], "call_1");
    }
}
