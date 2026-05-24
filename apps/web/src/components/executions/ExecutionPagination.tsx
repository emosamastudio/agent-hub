interface ExecutionPaginationProps {
  total: number;
  limit: number;
  offset: number;
  onChange: (limit: number, offset: number) => void;
}

export function ExecutionPagination({ total, limit, offset, onChange }: ExecutionPaginationProps) {
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const pages: number[] = [];
  for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) {
    pages.push(i);
  }

  return (
    <div className="execution-pagination">
      <span className="execution-pagination__info">Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
      <div className="execution-pagination__controls">
        <select value={limit} onChange={e => onChange(Number(e.target.value), 0)}>
          {[25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <button disabled={offset === 0} onClick={() => onChange(limit, Math.max(0, offset - limit))}>←</button>
        {pages[0] > 1 ? <><button onClick={() => onChange(limit, 0)}>1</button><span>…</span></> : null}
        {pages.map(p => <button key={p} className={p === currentPage ? "active" : ""} onClick={() => onChange(limit, (p - 1) * limit)}>{p}</button>)}
        {pages[pages.length - 1] < totalPages ? <><span>…</span><button onClick={() => onChange(limit, (totalPages - 1) * limit)}>{totalPages}</button></> : null}
        <button disabled={offset + limit >= total} onClick={() => onChange(limit, offset + limit)}>→</button>
      </div>
    </div>
  );
}
