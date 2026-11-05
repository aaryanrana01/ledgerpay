import { formatMinor } from './format.js';

/**
 * Fourteen days of money in and out, drawn as paired bars.
 * Hand-rolled SVG — a charting library would be more code shipped to the
 * browser than the twenty lines it would replace.
 */
export default function Sparkline({ series }) {
  const peak = Math.max(1, ...series.flatMap((day) => [day.inMinor, day.outMinor]));
  const slot = 100 / series.length;
  const barWidth = slot * 0.34;

  return (
    <>
      <svg className="spark" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Daily money in and out over the last fourteen days">
        <line x1="0" y1="39.5" x2="100" y2="39.5" stroke="var(--rule)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
        {series.map((day, index) => {
          const base = index * slot + slot * 0.12;
          const inHeight = (day.inMinor / peak) * 36;
          const outHeight = (day.outMinor / peak) * 36;
          return (
            <g key={day.date}>
              <rect className="bar-in" x={base} y={39.5 - inHeight} width={barWidth} height={Math.max(inHeight, day.inMinor ? 0.6 : 0)}>
                <title>{`${day.date} · in ${formatMinor(day.inMinor)}`}</title>
              </rect>
              <rect
                className="bar-out"
                x={base + barWidth + slot * 0.08}
                y={39.5 - outHeight}
                width={barWidth}
                height={Math.max(outHeight, day.outMinor ? 0.6 : 0)}
              >
                <title>{`${day.date} · out ${formatMinor(day.outMinor)}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="spark-axis">
        <span>{series[0]?.date.slice(5)}</span>
        <span className="credit">in</span>
        <span className="debit">out</span>
        <span>{series[series.length - 1]?.date.slice(5)}</span>
      </div>
    </>
  );
}
