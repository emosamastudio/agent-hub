import { useMemo } from "react";

interface ThroughputBucket {
  hour: string;
  success?: number;
  failed?: number;
  timeout?: number;
  cancelled?: number;
  running?: number;
  queued?: number;
}

const STATUS_COLORS: Record<string, string> = {
  success: "#22c55e",
  failed: "#ef4444",
  timeout: "#f59e0b",
  cancelled: "#64748b",
  running: "#3b82f6",
  queued: "#94a3b8",
};

const STACK_ORDER = ["queued", "running", "cancelled", "timeout", "failed", "success"];

interface SparklineProps {
  data: ThroughputBucket[];
  width?: number;
  height?: number;
}

export function Sparkline({ data, width = 600, height = 160 }: SparklineProps) {
  const maxVal = useMemo(() => {
    let m = 1;
    for (const b of data) {
      let sum = 0;
      for (const s of STACK_ORDER) sum += (b as any)[s] ?? 0;
      if (sum > m) m = sum;
    }
    return m;
  }, [data]);

  if (!data.length) return <div className="text-muted" style={{ padding: "1rem", fontSize: "0.85rem" }}>No throughput data available</div>;

  const barWidth = Math.max(5, Math.floor((width - 40) / data.length) - 2);

  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      {data.map((bucket, i) => {
        const x = 30 + i * (barWidth + 2);
        let y = height - 20;
        const bars: Array<{ y: number; h: number; color: string; status: string }> = [];

        // Build bars bottom-up
        for (const status of STACK_ORDER) {
          const count = (bucket as any)[status] ?? 0;
          if (count === 0) continue;
          const h = Math.max(1, Math.round((count / maxVal) * (height - 30)));
          y -= h;
          bars.push({ y, h, color: STATUS_COLORS[status] ?? "#94a3b8", status });
        }

        return bars.map((bar, _j => (
          <rect
            key={`${i}-${bar.status}`}
            x={x}
            y={bar.y}
            width={barWidth}
            height={bar.h}
            fill={bar.color}
            opacity={0.85}
            rx={1.5}
          >
            <title>{`${new Date(bucket.hour).toLocaleTimeString()}: ${bar.status} = ${(bucket as any)[bar.status]}`}</title>
          </rect>
        ));
      })}
    </svg>
  );
}
