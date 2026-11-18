/*
 * AgentDock prototype icons: original placeholder glyphs drawn for this
 * repository (16x16 grid, 1.5px stroke, currentColor). They are NOT copied
 * from any icon library or from Claude/Anthropic products. The production app
 * is expected to use Lucide (ISC AND MIT); see docs/ux/design-system.md#6-icons.
 */
(function () {
  'use strict';
  const S = (body, extra) =>
    `<svg class="ico${extra ? ' ' + extra : ''}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

  const paths = {
    // navigation & chrome
    menu: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
    home: '<path d="M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H9.5v-3h-3v3H3a.5.5 0 0 1-.5-.5z"/>',
    search: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6 5 5M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"/>',
    sun: '<circle cx="8" cy="8" r="2.75"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
    moon: '<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z"/>',
    contrast: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11" /><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none"/>',
    bell: '<path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3z"/><path d="M6.5 14h3"/>',
    bellAlert: '<path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3z"/><path d="M6.5 14h3"/><path d="M8 5.5v2.5" stroke-width="1.75"/><circle cx="8" cy="10" r=".4" fill="currentColor"/>',
    gauge: '<path d="M2.5 11a5.5 5.5 0 1 1 11 0"/><path d="M8 11 10.5 7"/><path d="M2.5 13.5h11"/>',
    chevronRight: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
    chevronDown: '<path d="m3.5 6 4.5 4.5L12.5 6"/>',
    x: '<path d="m4 4 8 8M12 4l-8 8"/>',
    pin: '<path d="M9.5 2.5 13.5 6.5 11 8l-1 3.5L4.5 6 8 5z"/><path d="M6.5 9.5 3 13"/>',
    branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-2 3-5 4"/>',
    folder: '<path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3A1 1 0 0 0 2 4.5z"/>',
    file: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>',
    send: '<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>',
    stop: '<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>',
    arrowDown: '<path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/>',
    archive: '<rect x="2" y="3" width="12" height="3" rx=".5"/><path d="M3 6v7h10V6M6.5 9h3"/>',
    keyboard: '<rect x="1.5" y="4" width="13" height="8" rx="1"/><path d="M4 7h1M7 7h2M11 7h1M5 9.5h6"/>',
    sidebarRight: '<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M10 2.5v11"/>',
    checks: '<path d="M2.5 4.5 4 6l2.5-2.5M2.5 10.5 4 12l2.5-2.5M9 5h4.5M9 11h4.5"/>',
    comment: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
    tool: '<path d="M10 2.5a3 3 0 0 0-2.8 4L2.5 11.2l2.3 2.3 4.7-4.7A3 3 0 0 0 13.5 6l-2 1.5-2-1 -.5-2z"/>',
    plan: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.75" cy="4" r=".75" fill="currentColor"/><circle cx="2.75" cy="8" r=".75" fill="currentColor"/><circle cx="2.75" cy="12" r=".75" fill="currentColor"/>',

    // task kinds
    kindLocal: '<rect x="2" y="3" width="12" height="8" rx="1"/><path d="M5.5 13.5h5M8 11v2.5"/>',
    kindBackground: '<path d="M8 2.5 14 5.5 8 8.5 2 5.5z"/><path d="m2 8.5 6 3 6-3"/><path d="m2 11.5 6 3 6-3" opacity=".55"/>',
    kindRemote: '<rect x="2.5" y="2.5" width="11" height="4.5" rx="1"/><rect x="2.5" y="9" width="11" height="4.5" rx="1"/><path d="M5 4.75h.01M5 11.25h.01" stroke-width="2"/>',

    // statuses (shape-coded; see states-and-indicators.md)
    stRunning: '<circle cx="8" cy="8" r="5.5" opacity=".25"/><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"/>',
    stApproval: '<path d="M8 1.75 14.25 8 8 14.25 1.75 8z" fill="currentColor" stroke="none"/><path d="M8 5v3.5" style="stroke:var(--ad-bg-surface)" stroke-width="1.75"/><circle cx="8" cy="10.75" r=".9" style="fill:var(--ad-bg-surface)" stroke="none"/>',
    stQuestion: '<path d="M2.5 3h11v7.5H8L5 13v-2.5H2.5z" fill="currentColor" stroke="none"/><path d="M6.6 5.6a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9" style="stroke:var(--ad-bg-surface)" stroke-width="1.4"/><circle cx="8" cy="9.1" r=".55" style="fill:var(--ad-bg-surface)" stroke="none"/>',
    stDoneNew: '<circle cx="8" cy="8" r="6" fill="currentColor" stroke="none"/><path d="m5.25 8.25 1.9 1.9 3.6-3.9" style="stroke:var(--ad-bg-surface)" stroke-width="1.6"/>',
    stDone: '<circle cx="8" cy="8" r="5.5"/><path d="m5.5 8.25 1.75 1.75 3.25-3.5"/>',
    stFailed: '<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3"/><circle cx="8" cy="11.5" r=".5" fill="currentColor"/>',
    stInterrupted: '<circle cx="8" cy="8" r="5.5" stroke-dasharray="2.5 2"/><path d="M6.5 6v4M9.5 6v4"/>',
    stQueued: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
    stCancelled: '<circle cx="8" cy="8" r="5.5"/><path d="m4.2 11.8 7.6-7.6"/>',
    stOffline: '<path d="M2 6.5a9 9 0 0 1 12 0M4.25 9a5.5 5.5 0 0 1 7.5 0M6.6 11.4a2 2 0 0 1 2.8 0"/><path d="m2.5 2.5 11 11"/>',
    stAuth: '<circle cx="5.5" cy="8" r="2.75"/><path d="M8.25 8h5.25M11.5 8v2M13.5 8v1.5"/>',
    stQuota: '<path d="M2.5 11a5.5 5.5 0 1 1 11 0"/><path d="M2.5 13.5h11"/><path d="m6.5 7.5 3 3M9.5 7.5l-3 3"/>',
    stLoading: '<path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5"/>',
    stArchived: '<rect x="2" y="3" width="12" height="3" rx=".5"/><path d="M3 6v7h10V6M6.5 9h3"/>',
  };

  window.AD = window.AD || {};
  window.AD.icon = function icon(name, extra) {
    const p = paths[name];
    if (!p) throw new Error('unknown icon ' + name);
    return S(p, extra);
  };
  window.AD.iconNames = Object.keys(paths);
})();
