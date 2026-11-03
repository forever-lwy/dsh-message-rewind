export const styles = `
.dmr-user-row { position: relative; }
.dmr-user-actions { display: flex; justify-content: flex-end; margin-top: 2px; opacity: 0; transition: opacity .15s ease; }
.dmr-user-row:hover .dmr-user-actions, .dmr-user-actions:focus-within, .dmr-user-actions[data-open] { opacity: 1; }
@media (hover: none) { .dmr-user-actions { opacity: 1; } }
.dmr-anchor { position: relative; display: inline-flex; }
.dmr-action { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 0;
  border-radius: var(--dsw-radius-sm, 6px); color: var(--dsw-alias-label-secondary, currentColor); background: transparent; cursor: pointer; }
.dmr-action:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.dmr-action:disabled { cursor: default; opacity: .5; }
.dmr-action svg { width: 16px; height: 16px; }
.dmr-panel { position: absolute; z-index: 40; right: 0; top: calc(100% + 4px); width: min(360px, calc(100vw - 32px)); box-sizing: border-box;
  padding: 12px; border-radius: var(--dsw-radius-md, 10px); text-align: left; white-space: normal;
  background: var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-primary, #fff)); color: var(--dsw-alias-label-primary, inherit);
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.25)); box-shadow: 0 6px 24px rgba(0,0,0,.16); font-size: 13px; line-height: 1.5; }
.dmr-panel[data-side="top"] { top: auto; bottom: calc(100% + 4px); }
.dmr-panel h4 { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
.dmr-panel p { margin: 0 0 6px; color: var(--dsw-alias-label-secondary, inherit); }
.dmr-panel p[data-tone="warn"] { color: var(--dsw-alias-label-warning, #b26b00); }
.dmr-panel p[data-tone="error"] { color: var(--dsw-alias-label-danger, #c62828); }
.dmr-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.dmr-button { padding: 4px 12px; border-radius: var(--dsw-radius-sm, 6px); border: 1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35));
  background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dmr-button[data-primary] { background: var(--dsw-alias-interactive-primary, #4d6bfe); border-color: transparent; color: #fff; }
.dmr-button:disabled { opacity: .6; cursor: default; }
`
