import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { dayHourLabel, hourLabel } from '../../lib/format';
import type { TimePoint } from '../../types/data';
import { t, locale } from '../../i18n';

export const CHART = {
  grid: '#18253f',
  axis: '#5c7096',
  tooltipBg: '#0d1628',
  tooltipBorder: '#33476b',
  colors: ['#22d3ee', '#3b82f6', '#a78bfa', '#f59e0b', '#22c55e', '#f43f5e'],
};

const axisProps = {
  stroke: CHART.axis,
  tick: { fill: CHART.axis, fontSize: 10.5 },
  tickLine: false,
  axisLine: { stroke: CHART.grid },
};

const tooltipProps = {
  contentStyle: { background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}`, borderRadius: 4, fontSize: 12 },
  labelStyle: { color: '#b9c5db', marginBottom: 2 },
  itemStyle: { padding: 0 },
};

export interface SeriesDef {
  key: string;
  label: string;
  color?: string;
  dashed?: boolean;
  /** Plot on a secondary right-hand axis (different unit/scale). */
  right?: boolean;
  unit?: string;
}

export function TimeChart({
  data,
  series,
  height = 180,
  area = false,
  multiDay = false,
  refLine,
  yDomain,
}: {
  data: TimePoint[];
  series: SeriesDef[];
  height?: number;
  area?: boolean;
  multiDay?: boolean;
  refLine?: { y: number; label: string };
  yDomain?: [number | 'auto', number | 'auto'];
}) {
  series = series.map((s) => ({ ...s, label: t(s.label) }));
  const tickFmt = multiDay ? dayHourLabel : hourLabel;
  const common = (
    <>
      <CartesianGrid stroke={CHART.grid} vertical={false} />
      <XAxis dataKey="time" tickFormatter={tickFmt} minTickGap={28} {...axisProps} />
      <YAxis yAxisId="l" width={38} domain={yDomain ?? ['auto', 'auto']} {...axisProps} />
      {series.some((s) => s.right) && <YAxis yAxisId="r" orientation="right" width={34} {...axisProps} />}
      <Tooltip
        {...tooltipProps}
        labelFormatter={(l) => new Date(String(l)).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
        formatter={(v, name) => {
          const s = series.find((x) => x.label === name);
          return [typeof v === 'number' ? `${v.toFixed(1)}${s?.unit ? ` ${s.unit}` : ''}` : '—', name];
        }}
      />
      {series.length > 1 && <Legend iconType="plainline" wrapperStyle={{ fontSize: 11, color: '#8a9bbb' }} />}
      {refLine && <ReferenceLine yAxisId="l" y={refLine.y} stroke="#f97316" strokeDasharray="4 3" label={{ value: t(refLine.label), fill: '#f97316', fontSize: 10, position: 'insideTopRight' }} />}
    </>
  );
  return (
    <ResponsiveContainer width="100%" height={height}>
      {area ? (
        <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color ?? CHART.colors[i]} stopOpacity={0.35} />
                <stop offset="100%" stopColor={s.color ?? CHART.colors[i]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          {common}
          {series.map((s, i) => (
            <Area key={s.key} yAxisId={s.right ? 'r' : 'l'} type="monotone" dataKey={s.key} name={s.label} stroke={s.color ?? CHART.colors[i]} fill={`url(#g-${s.key})`} strokeWidth={1.6} strokeDasharray={s.dashed ? '4 3' : undefined} dot={false} connectNulls isAnimationActive={false} />
          ))}
        </AreaChart>
      ) : (
        <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          {common}
          {series.map((s, i) => (
            <Line key={s.key} yAxisId={s.right ? 'r' : 'l'} type="monotone" dataKey={s.key} name={s.label} stroke={s.color ?? CHART.colors[i]} strokeWidth={1.6} strokeDasharray={s.dashed ? '4 3' : undefined} dot={false} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      )}
    </ResponsiveContainer>
  );
}

export function HBarChart({
  data,
  valueKey,
  labelKey,
  unit,
  height = 220,
  colorFor,
  onSelect,
}: {
  data: Record<string, unknown>[];
  valueKey: string;
  labelKey: string;
  unit?: string;
  height?: number;
  colorFor?: (row: Record<string, unknown>) => string;
  onSelect?: (row: Record<string, unknown>) => void;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={CHART.grid} horizontal={false} />
        <XAxis type="number" {...axisProps} />
        <YAxis type="category" dataKey={labelKey} width={64} {...axisProps} interval={0} />
        <Tooltip {...tooltipProps} cursor={{ fill: '#18253f' }} formatter={(v) => [`${typeof v === 'number' ? v.toFixed(1) : v}${unit ? ` ${unit}` : ''}`, '']} />
        <Bar dataKey={valueKey} radius={[0, 2, 2, 0]} isAnimationActive={false} onClick={(d) => onSelect?.(d as unknown as Record<string, unknown>)} cursor={onSelect ? 'pointer' : undefined}>
          {data.map((row, i) => (
            <Cell key={i} fill={colorFor ? colorFor(row) : CHART.colors[0]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
