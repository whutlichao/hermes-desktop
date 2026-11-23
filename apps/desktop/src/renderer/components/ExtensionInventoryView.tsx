import type { ExtensionCliAction, ExtensionInventoryView } from "@hermes/contracts";
import { getCopy } from "@hermes/domain";
import { AttributionBadge } from "./AttributionBadge";

export type ExtensionDomainTab = "plugins" | "skills" | "tools" | "mcp";

interface ExtensionInventoryViewProps {
  extensions: ExtensionInventoryView;
  activeTab: ExtensionDomainTab;
  busyDomain?: ExtensionDomainTab | null;
  testIdPrefix: string;
  onSelectTab: (tab: ExtensionDomainTab) => void;
  onRefresh: (domain: ExtensionDomainTab) => void;
  onReload: (domain: "skills" | "mcp") => void;
  onCopyCli: (command: string) => void;
  onOpenDocs: (url: string) => void;
}

const TABS: Array<{ id: ExtensionDomainTab; labelKey: "extensions.tab.plugins" | "extensions.tab.skills" | "extensions.tab.tools" | "extensions.tab.mcp" }> = [
  { id: "plugins", labelKey: "extensions.tab.plugins" },
  { id: "skills", labelKey: "extensions.tab.skills" },
  { id: "tools", labelKey: "extensions.tab.tools" },
  { id: "mcp", labelKey: "extensions.tab.mcp" },
];

function CliActionList({
  actions,
  testIdPrefix,
  onCopyCli,
}: {
  actions: ExtensionCliAction[];
  testIdPrefix: string;
  onCopyCli: (command: string) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div className="ext-cli-list">
      {actions.map((action) => (
        <div key={action.id} className="ext-cli-row">
          <code className="ext-cli-code">{action.command}</code>
          <button
            type="button"
            className="button button-secondary cap-action-btn"
            data-testid={`${testIdPrefix}-cli-${action.id}`}
            onClick={() => onCopyCli(action.command)}
          >
            {action.label}
          </button>
          <span className="ext-cli-note">{action.note}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Shared read-only inventory panel for Plugins, Skills, Tools, and MCP across
 * the Extensions drawer and Settings -> Plugins section.
 */
export function ExtensionInventoryViewPanel({
  extensions,
  activeTab,
  busyDomain,
  testIdPrefix,
  onSelectTab,
  onRefresh,
  onReload,
  onCopyCli,
  onOpenDocs,
}: ExtensionInventoryViewProps) {
  const isBusy = busyDomain === activeTab;

  return (
    <div className="ext-view" data-testid={testIdPrefix}>
      <div className="ext-tabs" role="tablist" aria-label={getCopy("extensions.title")}>
        {TABS.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={`${testIdPrefix}-tab-${tab.id}`}
              className={["ext-tab-btn", selected && "is-active"].filter(Boolean).join(" ")}
              onClick={() => onSelectTab(tab.id)}
            >
              {getCopy(tab.labelKey)}
            </button>
          );
        })}
      </div>

      {activeTab === "plugins" && (
        <div
          className="ext-panel"
          role="tabpanel"
          aria-label={getCopy("extensions.tab.plugins")}
          data-testid={`${testIdPrefix}-panel-plugins`}
        >
          <div className="ext-top-notice">
            <div className="ext-panel-header">
              <h4 className="ext-panel-title">{getCopy("extensions.plugins.title")}</h4>
              <span className="gateway-badge">{extensions.sourceLabel}</span>
            </div>
            <div className="ext-intro-lines">
              <p>{getCopy("extensions.plugins.introLine1")}</p>
              <p>{getCopy("extensions.plugins.introLine2")}</p>
              <p>{getCopy("extensions.plugins.introLine3")}</p>
            </div>
            <p className="ext-scope-note">{getCopy("extensions.plugins.scopeIsolationNote")}</p>
            {extensions.pluginRpcAdvertised && (
              <p
                className="cap-notice"
                role="status"
                data-testid={`${testIdPrefix}-plugin-rpc-notice`}
              >
                {getCopy("extensions.plugins.rpcOwnerNotice")}
              </p>
            )}
            <div className="ext-toolbar">
              <button
                type="button"
                className="button button-secondary cap-action-btn"
                disabled={isBusy}
                data-testid={`${testIdPrefix}-refresh-plugins`}
                onClick={() => onRefresh("plugins")}
              >
                {getCopy("extensions.refreshAction")}
              </button>
              <button
                type="button"
                className="button button-secondary cap-action-btn"
                data-testid={`${testIdPrefix}-docs-plugins`}
                onClick={() => onOpenDocs(extensions.docsUrl)}
              >
                {getCopy("extensions.openDocsAction")}
              </button>
            </div>
            <CliActionList
              actions={extensions.cliActions}
              testIdPrefix={`${testIdPrefix}-plugins`}
              onCopyCli={onCopyCli}
            />
          </div>

          <div
            className="ext-list-region"
            data-inventory-status={extensions.status}
            data-testid={`${testIdPrefix}-plugins-state`}
          >
            {extensions.status === "available" ? (
              <ul className="ext-card-list">
                {extensions.plugins.map((plugin) => (
                  <li
                    key={plugin.pluginKey}
                    className="ext-card"
                    data-testid={`${testIdPrefix}-plugin-row-${plugin.pluginKey}`}
                  >
                    <div className="ext-card-header">
                      <div className="ext-card-title-wrap">
                        <strong>{plugin.name}</strong>
                        <span className="cap-class-tag">
                          {getCopy("extensions.plugins.versionLabel")}: {plugin.version}
                        </span>
                        {plugin.key && (
                          <span className="cap-class-tag">
                            {getCopy("extensions.plugins.keyLabel")}: {plugin.key}
                          </span>
                        )}
                      </div>
                      <AttributionBadge attribution={plugin.attribution} />
                    </div>

                    <div className="ext-card-badges">
                      <span className="gateway-badge">{plugin.enabledLabel}</span>
                      <span
                        className={[
                          "cap-status-badge",
                          plugin.loadStatus === "failed"
                            ? "is-unavailable"
                            : plugin.loadStatus === "ok"
                              ? "is-available"
                              : "is-unknown",
                        ].join(" ")}
                      >
                        {plugin.loadStatusLabel}
                      </span>
                      {plugin.loadStatus === "failed" && plugin.errorCode && (
                        <span className="ext-error-code">
                          {getCopy("extensions.errorCodePrefix")}: {plugin.errorCode}
                        </span>
                      )}
                    </div>

                    <div className="ext-card-meta">
                      <span>
                        {getCopy("extensions.plugins.toolCountLabel")}:{" "}
                        {plugin.toolCount !== undefined
                          ? plugin.toolCount
                          : getCopy("extensions.unreportedValue")}
                      </span>
                      <span>
                        {getCopy("extensions.plugins.hookCountLabel")}:{" "}
                        {plugin.hookCount !== undefined
                          ? plugin.hookCount
                          : getCopy("extensions.unreportedValue")}
                      </span>
                      <span>
                        {getCopy("extensions.plugins.commandCountLabel")}:{" "}
                        {plugin.commandCount !== undefined
                          ? plugin.commandCount
                          : getCopy("extensions.unreportedValue")}
                      </span>
                      <span>{plugin.skillsLabel}</span>
                      <button
                        type="button"
                        className="button button-secondary cap-action-btn"
                        data-testid={`${testIdPrefix}-plugin-view-skills-${plugin.pluginKey}`}
                        onClick={() => onSelectTab("skills")}
                      >
                        {getCopy("extensions.plugins.viewSkillsAction")}
                      </button>
                    </div>

                    <CliActionList
                      actions={plugin.cliActions}
                      testIdPrefix={`${testIdPrefix}-plugin-${plugin.pluginKey}`}
                      onCopyCli={onCopyCli}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="ext-state-box" role="status">
                {extensions.status === "empty" && (
                  <>
                    <strong>{getCopy("extensions.plugins.stateEmptyTitle")}</strong>
                    <p>{getCopy("extensions.plugins.stateEmptyHint")}</p>
                  </>
                )}
                {extensions.status === "unsupported" && (
                  <>
                    <strong>{getCopy("extensions.plugins.stateUnsupportedTitle")}</strong>
                    <p>{getCopy("extensions.plugins.stateUnsupportedHint")}</p>
                  </>
                )}
                {extensions.status === "unknown" && (
                  <>
                    <strong>{getCopy("extensions.plugins.stateUnknownTitle")}</strong>
                    <p>{getCopy("extensions.plugins.stateUnknownHint")}</p>
                  </>
                )}
                {extensions.status === "error" && (
                  <>
                    <strong>{getCopy("extensions.plugins.stateErrorTitle")}</strong>
                    <p>{getCopy("extensions.plugins.stateErrorHint")}</p>
                    {extensions.errorCode && (
                      <p className="ext-error-code">
                        {getCopy("extensions.errorCodePrefix")}: {extensions.errorCode}
                      </p>
                    )}
                    <button
                      type="button"
                      className="button button-secondary cap-action-btn"
                      disabled={isBusy}
                      data-testid={`${testIdPrefix}-retry-plugins`}
                      onClick={() => onRefresh("plugins")}
                    >
                      {getCopy("extensions.plugins.retryAction")}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "skills" && (
        <div
          className="ext-panel"
          role="tabpanel"
          aria-label={getCopy("extensions.tab.skills")}
          data-testid={`${testIdPrefix}-panel-skills`}
        >
          <div className="ext-top-notice">
            <div className="ext-panel-header">
              <h4 className="ext-panel-title">{getCopy("extensions.skills.title")}</h4>
              <span className="gateway-badge">{extensions.sourceLabel}</span>
            </div>
            <p className="ext-scope-note">{getCopy("extensions.skills.readOnlyNote")}</p>
            <div className="ext-toolbar">
              <button
                type="button"
                className="button button-secondary cap-action-btn"
                disabled={isBusy}
                data-testid={`${testIdPrefix}-refresh-skills`}
                onClick={() => onRefresh("skills")}
              >
                {getCopy("extensions.refreshAction")}
              </button>
              {extensions.skills.reloadSupported && (
                <button
                  type="button"
                  className="button button-secondary cap-action-btn"
                  disabled={isBusy}
                  data-testid={`${testIdPrefix}-reload-skills`}
                  onClick={() => onReload("skills")}
                >
                  {getCopy("extensions.skills.reloadAction")}
                </button>
              )}
              <button
                type="button"
                className="button button-secondary cap-action-btn"
                data-testid={`${testIdPrefix}-docs-skills`}
                onClick={() => onOpenDocs(extensions.skills.docsUrl)}
              >
                {getCopy("extensions.openDocsAction")}
              </button>
            </div>
            <CliActionList
              actions={extensions.skills.cliActions}
              testIdPrefix={`${testIdPrefix}-skills`}
              onCopyCli={onCopyCli}
            />
          </div>

          <div
            className="ext-list-region"
            data-inventory-status={extensions.skills.status}
            data-testid={`${testIdPrefix}-skills-state`}
          >
            {extensions.skills.status === "available" ? (
              <ul className="ext-card-list">
                {extensions.skills.items.map((skill) => (
                  <li
                    key={skill.skillId}
                    className="ext-card"
                    data-testid={`${testIdPrefix}-skill-row-${skill.skillId}`}
                  >
                    <div className="ext-card-header">
                      <div className="ext-card-title-wrap">
                        <strong>{skill.name}</strong>
                        {skill.category && <span className="cap-class-tag">{skill.category}</span>}
                        {skill.enabled !== undefined && (
                          <span className="gateway-badge">
                            {getCopy(
                              skill.enabled
                                ? "extensions.itemEnabled"
                                : "extensions.itemDisabled",
                            )}
                          </span>
                        )}
                      </div>
                      <AttributionBadge attribution={skill.attribution} />
                    </div>
                    {skill.description && <p className="ext-card-desc">{skill.description}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="ext-state-box" role="status">
                {extensions.skills.status === "empty" && (
                  <p>{getCopy("extensions.skills.stateEmpty")}</p>
                )}
                {extensions.skills.status === "unsupported" && (
                  <p>{getCopy("extensions.skills.stateUnsupported")}</p>
                )}
                {extensions.skills.status === "unknown" && (
                  <p>{getCopy("extensions.skills.stateUnknown")}</p>
                )}
                {extensions.skills.status === "error" && (
                  <>
                    <p>{getCopy("extensions.skills.stateError")}</p>
                    {extensions.skills.errorCode && (
                      <p className="ext-error-code">
                        {getCopy("extensions.errorCodePrefix")}: {extensions.skills.errorCode}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "tools" && (
        <div
          className="ext-panel"
          role="tabpanel"
          aria-label={getCopy("extensions.tab.tools")}
          data-testid={`${testIdPrefix}-panel-tools`}
        >
          <div className="ext-top-notice">
            <div className="ext-panel-header">
              <h4 className="ext-panel-title">{getCopy("extensions.tools.title")}</h4>
              <span className="gateway-badge">{extensions.sourceLabel}</span>
            </div>
            <p className="ext-scope-note">{getCopy("extensions.tools.readOnlyNote")}</p>
            <div className="ext-toolbar">
              <button
                type="button"
                className="button button-secondary cap-action-btn"
                disabled={isBusy}
                data-testid={`${testIdPrefix}-refresh-tools`}
                onClick={() => onRefresh("tools")}
              >
                {getCopy("extensions.refreshAction")}
              </button>
              <button
                type="button"
                className="button button-secondary cap-action-btn"
                data-testid={`${testIdPrefix}-docs-tools`}
                onClick={() => onOpenDocs(extensions.tools.docsUrl)}
              >
                {getCopy("extensions.openDocsAction")}
              </button>
            </div>
            <CliActionList
              actions={extensions.tools.cliActions}
              testIdPrefix={`${testIdPrefix}-tools`}
              onCopyCli={onCopyCli}
            />
          </div>

          <div
            className="ext-list-region"
            data-inventory-status={extensions.tools.status}
            data-testid={`${testIdPrefix}-tools-state`}
          >
            {extensions.tools.status === "available" ? (
              <ul className="ext-card-list">
                {extensions.tools.items.map((tool) => (
                  <li
                    key={tool.toolId}
                    className="ext-card"
                    data-testid={`${testIdPrefix}-tool-row-${tool.toolId}`}
                  >
                    <div className="ext-card-header">
                      <div className="ext-card-title-wrap">
                        <strong>{tool.name}</strong>
                        {tool.toolset && <span className="cap-class-tag">{tool.toolset}</span>}
                        {tool.enabled !== undefined && (
                          <span className="gateway-badge">
                            {getCopy(
                              tool.enabled
                                ? "extensions.itemEnabled"
                                : "extensions.itemDisabled",
                            )}
                          </span>
                        )}
                      </div>
                      <AttributionBadge attribution={tool.attribution} />
                    </div>
                    {tool.description && <p className="ext-card-desc">{tool.description}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="ext-state-box" role="status">
                {extensions.tools.status === "empty" && (
                  <p>{getCopy("extensions.tools.stateEmpty")}</p>
                )}
                {extensions.tools.status === "unsupported" && (
                  <p>{getCopy("extensions.tools.stateUnsupported")}</p>
                )}
                {extensions.tools.status === "unknown" && (
                  <p>{getCopy("extensions.tools.stateUnknown")}</p>
                )}
                {extensions.tools.status === "error" && (
                  <>
                    <p>{getCopy("extensions.tools.stateError")}</p>
                    {extensions.tools.errorCode && (
                      <p className="ext-error-code">
                        {getCopy("extensions.errorCodePrefix")}: {extensions.tools.errorCode}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "mcp" && (
        <div
          className="ext-panel"
          role="tabpanel"
          aria-label={getCopy("extensions.tab.mcp")}
          data-testid={`${testIdPrefix}-panel-mcp`}
        >
          <div className="ext-top-notice">
            <div className="ext-panel-header">
              <h4 className="ext-panel-title">{getCopy("extensions.mcp.title")}</h4>
              <span className="gateway-badge">{extensions.sourceLabel}</span>
            </div>
            <p className="ext-scope-note">{getCopy("extensions.mcp.readOnlyNote")}</p>
            <div className="ext-toolbar">
              <button
                type="button"
                className="button button-secondary cap-action-btn"
                disabled={isBusy}
                data-testid={`${testIdPrefix}-refresh-mcp`}
                onClick={() => onRefresh("mcp")}
              >
                {getCopy("extensions.refreshAction")}
              </button>
              {extensions.mcp.reloadSupported && (
                <button
                  type="button"
                  className="button button-secondary cap-action-btn"
                  disabled={isBusy}
                  data-testid={`${testIdPrefix}-reload-mcp`}
                  onClick={() => onReload("mcp")}
                >
                  {getCopy("extensions.mcp.reloadAction")}
                </button>
              )}
              <button
                type="button"
                className="button button-secondary cap-action-btn"
                data-testid={`${testIdPrefix}-docs-mcp`}
                onClick={() => onOpenDocs(extensions.mcp.docsUrl)}
              >
                {getCopy("extensions.openDocsAction")}
              </button>
            </div>
            <CliActionList
              actions={extensions.mcp.cliActions}
              testIdPrefix={`${testIdPrefix}-mcp`}
              onCopyCli={onCopyCli}
            />
          </div>

          <div
            className="ext-list-region"
            data-inventory-status={extensions.mcp.status}
            data-testid={`${testIdPrefix}-mcp-state`}
          >
            {extensions.mcp.status === "available" ? (
              <ul className="ext-card-list">
                {extensions.mcp.items.map((server) => (
                  <li
                    key={server.serverId}
                    className="ext-card"
                    data-testid={`${testIdPrefix}-mcp-row-${server.serverId}`}
                  >
                    <div className="ext-card-header">
                      <div className="ext-card-title-wrap">
                        <strong>{server.name}</strong>
                        <span
                          className={[
                            "cap-status-badge",
                            server.status === "connected"
                              ? "is-available"
                              : server.status === "error"
                                ? "is-unavailable"
                                : "is-unknown",
                          ].join(" ")}
                        >
                          {server.statusLabel}
                        </span>
                      </div>
                      <AttributionBadge attribution={server.attribution} />
                    </div>
                    <div className="ext-card-meta">
                      {server.toolCount !== undefined && (
                        <span>
                          {getCopy("extensions.mcp.toolCountPrefix")}: {server.toolCount}
                        </span>
                      )}
                      {server.errorCode && (
                        <span className="ext-error-code">
                          {getCopy("extensions.errorCodePrefix")}: {server.errorCode}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="ext-state-box" role="status">
                {extensions.mcp.status === "empty" && (
                  <p>{getCopy("extensions.mcp.stateEmpty")}</p>
                )}
                {extensions.mcp.status === "unsupported" && (
                  <p>{getCopy("extensions.mcp.stateUnsupported")}</p>
                )}
                {extensions.mcp.status === "unknown" && (
                  <p>{getCopy("extensions.mcp.stateUnknown")}</p>
                )}
                {extensions.mcp.status === "error" && (
                  <>
                    <p>{getCopy("extensions.mcp.stateError")}</p>
                    {extensions.mcp.errorCode && (
                      <p className="ext-error-code">
                        {getCopy("extensions.errorCodePrefix")}: {extensions.mcp.errorCode}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
