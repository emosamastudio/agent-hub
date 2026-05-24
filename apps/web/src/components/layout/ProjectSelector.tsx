import { useState, useRef, useEffect } from "react";
import type { Project } from "../../lib/types.js";

interface ProjectSelectorProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelect: (projectId: string | null) => void;
}

export function ProjectSelector({ projects, selectedProjectId, onSelect }: ProjectSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selected = projects.find(p => p.id === selectedProjectId);

  return (
    <div className="project-selector" ref={ref}>
      <button className="project-selector__trigger" onClick={() => setOpen(!open)}>
        <span className="project-selector__icon">P</span>
        <span className="project-selector__name">{selected?.displayName ?? "All Projects"}</span>
        <span className="project-selector__chevron">{open ? "▲" : "▼"}</span>
      </button>
      {open ? (
        <div className="project-selector__dropdown">
          <button
            className={`project-selector__item ${!selectedProjectId ? "active" : ""}`}
            onClick={() => { onSelect(null); setOpen(false); }}
          >
            <span className="project-selector__item-name">All Projects</span>
            <span className="project-selector__item-count">{projects.reduce((s) => s + 1, 0)}</span>
          </button>
          {projects.filter(p => p.status === "active").map(p => (
            <button
              key={p.id}
              className={`project-selector__item ${selectedProjectId === p.id ? "active" : ""}`}
              onClick={() => { onSelect(p.id); setOpen(false); }}
            >
              <span className="project-selector__item-name">{p.displayName}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
