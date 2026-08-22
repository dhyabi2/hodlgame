"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { fmtNum } from "../lib/trade";

interface Point { time: number; priceRaw: string }
interface Trade { kind: "buy" | "sell"; amountRaw: string; priceRaw: string; time: number }

const TF = [
  { k: "5m", s: 300 },
  { k: "15m", s: 900 },
  { k: "1h", s: 3600 },
  { k: "4h", s: 14400 },
  { k: "1d", s: 86400 },
] as const;

const UP = "#22c55e";  // soft green
const DOWN = "#ef4444"; // soft red
const priceNum = (raw: string) => Number(BigInt(raw)) / 1e30;
const fmtP = (v: number) => fmtNum(v, 4);

interface Candle { time: UTCTimestamp; open: number; high: number; low: number; close: number }

function buildCandles(series: Point[], tf: number): Candle[] {
  const m = new Map<number, Candle>();
  for (const p of series) {
    const v = priceNum(p.priceRaw);
    if (!Number.isFinite(v)) continue;
    const b = Math.floor(p.time / tf) * tf;
    const e = m.get(b);
    if (!e) m.set(b, { time: b as UTCTimestamp, open: v, high: v, low: v, close: v });
    else { e.high = Math.max(e.high, v); e.low = Math.min(e.low, v); e.close = v; }
  }
  return Array.from(m.values()).sort((a, b) => (a.time as number) - (b.time as number));
}
function buildVolume(trades: Trade[], tf: number, dec: number) {
  const m = new Map<number, { buy: number; sell: number }>();
  for (const t of trades) {
    const b = Math.floor(t.time / tf) * tf;
    const xno = (Number(BigInt(t.amountRaw)) / 10 ** dec) * priceNum(t.priceRaw);
    const e = m.get(b) ?? { buy: 0, sell: 0 };
    if (t.kind === "buy") e.buy += xno; else e.sell += xno;
    m.set(b, e);
  }
  return Array.from(m.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, v]) => ({
      time: time as UTCTimestamp,
      value: v.buy + v.sell,
      color: v.buy >= v.sell ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)",
    }));
}

/**
 * Token price chart. Line/Candles toggle, timeframe selector, a volume pane, and
 * a crosshair OHLC legend. Critically, the chart is built ONCE and only its data
 * is updated on the 4s market poll — so the user's zoom/pan survives refreshes
 * instead of the whole chart being torn down and rebuilt.
 */
export default function PriceChart({
  series,
  trades = [],
  decimals = 6,
  symbol = "",
}: {
  series: Point[];
  trades?: Trade[];
  decimals?: number;
  symbol?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<"Area"> | ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const maRef = useRef<ISeriesApi<"Line"> | null>(null);
  // keep latest props for the data-updater without re-creating the chart
  const dataRef = useRef({ series, trades, decimals });
  dataRef.current = { series, trades, decimals };

  const [type, setType] = useState<"area" | "candles">("candles");
  const [tf, setTf] = useState(0); // 5m
  const [legend, setLegend] = useState<{ o?: number; h?: number; l?: number; c: number } | null>(null);

  // Token prices can be astronomically small (1e-14 XNO). lightweight-charts'
  // tick calculator breaks on such magnitudes (minMove 1e-18 → base 1e18 loses
  // float precision → "unexpected base" throw → blank chart). So the chart is
  // fed SCALED values (~1..10) and every label divides the scale back out.
  const scaleRef = useRef(1);

  // (re)build the chart only when the render type or timeframe changes.
  useEffect(() => {
    if (!wrap.current) return;
    const prices = dataRef.current.series.map((p) => priceNum(p.priceRaw)).filter((v) => Number.isFinite(v) && v > 0);
    const maxP = prices.length ? Math.max(...prices) : 0;
    scaleRef.current = maxP > 0 && maxP < 0.001 ? 10 ** Math.ceil(-Math.log10(maxP)) : 1;
    const chart = createChart(wrap.current, {
      width: wrap.current.clientWidth,
      height: 320,
      layout: { background: { type: ColorType.Solid, color: "#000000" }, textColor: "#a3a3a3", fontSize: 11 },
      grid: { vertLines: { color: "rgba(255,255,255,0.06)" }, horzLines: { color: "rgba(255,255,255,0.06)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.2)", scaleMargins: { top: 0.08, bottom: 0.28 } },
      timeScale: { borderColor: "rgba(255,255,255,0.2)", timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,0.4)", labelBackgroundColor: "#404040" },
        horzLine: { color: "rgba(255,255,255,0.4)", labelBackgroundColor: "#404040" },
      },
    });
    chartRef.current = chart;

    const price =
      type === "candles"
        ? chart.addCandlestickSeries({
            // soft green/red candles (muted TradingView palette) on the otherwise
            // monochrome page — pleasant, not harsh.
            upColor: UP, downColor: DOWN, borderVisible: true,
            borderUpColor: UP, borderDownColor: DOWN,
            wickUpColor: UP, wickDownColor: DOWN,
            priceFormat: { type: "custom", formatter: (p: number) => fmtP(p / scaleRef.current), minMove: 1e-8 },
          })
        : chart.addAreaSeries({
            lineColor: UP, topColor: "rgba(34,197,94,0.14)", bottomColor: "rgba(34,197,94,0)", lineWidth: 2,
            priceFormat: { type: "custom", formatter: (p: number) => fmtP(p / scaleRef.current), minMove: 1e-8 },
          });
    priceRef.current = price as any;

    const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" } });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volRef.current = vol;

    // 20-period moving average overlay — the standard "is this above/below
    // trend" reference line traders expect on any serious chart.
    const ma = chart.addLineSeries({
      color: "#737373", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      priceFormat: { type: "custom", formatter: (p: number) => fmtP(p / scaleRef.current), minMove: 1e-8 },
    });
    maRef.current = ma;

    applyData(true);

    chart.subscribeCrosshairMove((param) => {
      const d = param.seriesData.get(price as any) as any;
      const s = scaleRef.current;
      if (!d) { setLegend(null); return; }
      if ("close" in d) setLegend({ o: d.open / s, h: d.high / s, l: d.low / s, c: d.close / s });
      else setLegend({ c: d.value / s });
    });

    const onResize = () => wrap.current && chart.applyOptions({ width: wrap.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); chartRef.current = null; priceRef.current = null; volRef.current = null; maRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, tf]);

  // update DATA only (no teardown) whenever the polled series/trades change.
  useEffect(() => { applyData(false); /* eslint-disable-next-line */ }, [series, trades]);

  function applyData(fit: boolean) {
    const { series, trades, decimals } = dataRef.current;
    const p = priceRef.current, v = volRef.current;
    if (!p) return;
    const secs = TF[tf].s;
    const s = scaleRef.current;
    const scaled = buildCandles(series, secs).map((c) => ({
      time: c.time, open: c.open * s, high: c.high * s, low: c.low * s, close: c.close * s,
    }));
    if (type === "candles") (p as ISeriesApi<"Candlestick">).setData(scaled);
    else (p as ISeriesApi<"Area">).setData(scaled.map((c) => ({ time: c.time, value: c.close })));
    if (maRef.current) {
      const PERIOD = 20;
      const maData = scaled.map((c, i) => {
        const from = Math.max(0, i - PERIOD + 1);
        const win = scaled.slice(from, i + 1);
        return { time: c.time, value: win.reduce((a, x) => a + x.close, 0) / win.length };
      });
      maRef.current.setData(maData);
    }
    if (v) v.setData(buildVolume(trades, secs, decimals));
    const cands = buildCandles(series, secs);
    const last = cands[cands.length - 1];
    if (last) setLegend((prev) => prev ?? { o: last.open, h: last.high, l: last.low, c: last.close });
    if (fit) chartRef.current?.timeScale().fitContent();
  }

  const cands = buildCandles(series, TF[tf].s);
  const last = cands[cands.length - 1];
  const up = last ? last.close >= last.open : true;

  return (
    <div className="relative">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-none bg-neutral-950 p-0.5">
          {(["candles", "area"] as const).map((t) => (
            <button key={t}
              className={"rounded-none px-2 py-0.5 text-[11px] font-bold " + (type === t ? "bg-white text-black" : "text-neutral-500 hover:text-white")}
              onClick={() => setType(t)}>{t === "candles" ? "Candles" : "Line"}</button>
          ))}
        </div>
        {cands.length > 0 && (
          <span className="hidden sm:inline text-[10px] text-neutral-500 tabular-nums">
            H <span className="text-green-500">{fmtP(Math.max(...cands.map((c) => c.high)))}</span>{" "}
            L <span className="text-red-500">{fmtP(Math.min(...cands.map((c) => c.low)))}</span>
            <span className="ml-2 text-neutral-500">— MA20</span>
          </span>
        )}
        <div className="flex gap-0.5">
          {TF.map((t, i) => (
            <button key={t.k}
              className={"rounded-none px-1.5 py-0.5 text-[11px] font-bold " + (i === tf ? "bg-white text-black" : "text-neutral-500 hover:text-white")}
              onClick={() => setTf(i)}>{t.k}</button>
          ))}
        </div>
      </div>

      <div ref={wrap} style={{ height: 320, width: "100%" }} />

      {legend && (
        <div className="pointer-events-none absolute left-2 top-10 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono tabular-nums">
          {legend.o != null ? (
            <>
              <span className="text-neutral-500">O <span style={{ color: up ? UP : DOWN }}>{fmtP(legend.o)}</span></span>
              <span className="text-neutral-500">H <span style={{ color: up ? UP : DOWN }}>{fmtP(legend.h!)}</span></span>
              <span className="text-neutral-500">L <span style={{ color: up ? UP : DOWN }}>{fmtP(legend.l!)}</span></span>
              <span className="text-neutral-500">C <span style={{ color: up ? UP : DOWN }}>{fmtP(legend.c)}</span></span>
            </>
          ) : (
            <span className="text-neutral-500">{symbol || "price"} <span className="text-white">{fmtP(legend.c)} XNO</span></span>
          )}
        </div>
      )}
    </div>
  );
}
