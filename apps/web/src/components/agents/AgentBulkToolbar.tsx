interface AgentBulkToolbarProps {
  selectedIds: string[];
  onEnable: () => void;
  onDisable: () => void;
  onDrain: () => void;
  onClearSelection: () => void;
}

export function AgentBulkToolbar({ selectedIds, onEnable, onDisable, onDrain, onClearSelection }: AgentBulkToolbarProps) {
  if (!selectedIds.length) return null;

  return (
    <div className="agent-bulk-toolbar">
      <span>
        {selectedIds.length} agent{selectedIds.length !== 1 ? "s" : ""} selected
      </span>
      <button onClick={onEnable} className="ghost-button">
        Enable
      </button>
      <button onClick={onDisable} className="ghost-button">
        Disable
      </button>
      <button onClick={onDrain} className="ghost-button" style={{ color: "#fca5a5" }}>
        Drain
      </button>
      <button onClick={onClearSelection} className="ghost-button">
        Clear
      </button>
    </div>
  );
}
