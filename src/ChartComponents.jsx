import React, { useEffect, useRef } from 'react';
import { createChart } from 'lightweight-charts';

export function MiniChart({ symbol, type, currency }) {
  const chartContainerRef = useRef();

  useEffect(() => {
    let chart;
    const fetchAndDraw = async () => {
      try {
        const res = await fetch(`/api/sparkline/${encodeURIComponent(symbol)}`);
        const data = await res.json();
        if (!res.ok) return;

        chart = createChart(chartContainerRef.current, {
          width: 80, height: 35,
          layout: { background: { type: 'solid', color: 'transparent' }, textColor: 'transparent' },
          grid: { vertLines: { visible: false }, horzLines: { visible: false } },
          timeScale: { visible: false }, rightPriceScale: { visible: false }, leftPriceScale: { visible: false },
          handleScroll: false, handleScale: false, crosshair: { mode: 0 }
        });

        const lineSeries = chart.addLineSeries({
          color: data[data.length - 1]?.value >= data[0]?.value ? '#10b981' : '#ef4444',
          lineWidth: 2, crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false
        });
        lineSeries.setData(data.map(d => ({ time: d.time, value: d.value })));
      } catch (e) {
      }
    };
    fetchAndDraw();
    return () => chart && chart.remove();
  }, [symbol]);

  return <div ref={chartContainerRef} style={{ width: 80, height: 35 }} />;
}

export function PieChart({ data }) {
  const canvasRef = useRef();

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const total = data.reduce((s, d) => s + d.value, 0);
    
    let startAngle = -0.5 * Math.PI;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (total === 0) return;

    const cx = canvas.width / 2, cy = canvas.height / 2, radius = Math.min(cx, cy) - 5;
    
    data.forEach(d => {
      const sliceAngle = (d.value / total) * 2 * Math.PI;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, startAngle, startAngle + sliceAngle);
      ctx.closePath();
      ctx.fillStyle = d.color;
      ctx.fill();
      startAngle += sliceAngle;
    });
  }, [data]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', justifyContent: 'center' }}>
      <canvas ref={canvasRef} width={120} height={120} style={{ width: 120, height: 120 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1 }}>
        {data.map(d => (
          <div key={d.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: d.color }}></div>
              <span style={{ color: 'var(--text-secondary)' }}>{d.label}</span>
            </div>
            <strong>{((d.value / data.reduce((s, x) => s + x.value, 0)) * 100).toFixed(1)}%</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AssetAllocationBar({ holdings, balance, totalKRW, usdKrw }) {
  if (totalKRW <= 0) return null;
  const items = [];
  if (balance > 0) items.push({ value: balance, color: '#6b7280' });
  const colors = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16','#ec4899'];
  
  (holdings || []).forEach((h, i) => {
    const p = h.type === 'KRW' || h.avgPrice > 10000 ? h.avgPrice : h.avgPrice * usdKrw;
    items.push({ value: h.quantity * p, color: colors[i % 9] });
  });

  return (
    <div style={{ display: 'flex', height: '6px', width: '100%', borderRadius: '3px', overflow: 'hidden', marginTop: '6px' }}>
      {items.map((it, i) => (
        <div key={i} style={{ width: `${(it.value / totalKRW) * 100}%`, backgroundColor: it.color }} />
      ))}
    </div>
  );
}

export function ChartModal({ asset, onClose }) {
  const chartContainerRef = useRef();
  const [interval, setInterval] = React.useState('1d');
  const [period, setPeriod] = React.useState('1mo');
  const [error, setError] = React.useState('');

  useEffect(() => {
    let chart, lineSeries;
    const fetchAndDraw = async () => {
      setError('');
      try {
        const res = await fetch(`/api/chart/${encodeURIComponent(asset.symbol)}?interval=${interval}&range=${period}`);
        const data = await res.json();
        
        if (!res.ok) { setError(data.error || '차트 로딩 실패'); return; }
        if (data.length === 0) { setError('데이터가 없습니다.'); return; }

        if (chartContainerRef.current) {
          chartContainerRef.current.innerHTML = '';
          chart = createChart(chartContainerRef.current, {
            width: chartContainerRef.current.clientWidth, height: 300,
            layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#9ca3af' },
            grid: { vertLines: { color: 'rgba(255, 255, 255, 0.05)' }, horzLines: { color: 'rgba(255, 255, 255, 0.05)' } },
            timeScale: { timeVisible: true, secondsVisible: false, borderColor: 'rgba(255,255,255,0.1)' },
            rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' }
          });
          
          lineSeries = chart.addAreaSeries({
            lineColor: data[data.length-1].value >= data[0].value ? '#10b981' : '#ef4444',
            topColor: data[data.length-1].value >= data[0].value ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)',
            bottomColor: 'rgba(0, 0, 0, 0)',
            lineWidth: 2,
          });
          
          lineSeries.setData(data.map(d => ({ time: d.time, value: d.value })));
          chart.timeScale().fitContent();
        }
      } catch (e) {
        setError('차트 데이터 로딩 실패: ' + e.message);
      }
    };
    
    fetchAndDraw();
    return () => chart && chart.remove();
  }, [asset.symbol, interval, period]);

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
         style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(4px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 2000 }}>
      <div className="glass-panel" style={{ width: '100%', maxWidth: '700px', padding: '1.5rem', position: 'relative' }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 15, right: 15, background: 'none', border: 'none', color: 'white', fontSize: '1.5rem', cursor: 'pointer' }}>×</button>
        <h2 style={{ marginBottom: '0.2rem' }}>{asset.name}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.2rem' }}>{asset.symbol}</p>
        
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          {[['1d','1mo','1달 (일봉)'], ['1wk','3mo','3달 (주봉)'], ['1mo','1y','1년 (월봉)'], ['1d','ytd','YTD (일봉)'], ['1mo','5y','5년 (월봉)']].map(([iv, rng, lbl]) => (
            <button key={rng} className="btn" onClick={() => { setInterval(iv); setPeriod(rng); }}
                    style={{ padding: '4px 10px', fontSize: '0.8rem', background: period === rng ? 'var(--accent-color)' : 'rgba(255,255,255,0.1)', color: 'white' }}>
              {lbl}
            </button>
          ))}
        </div>
        
        {error ? (
          <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--danger-color)' }}>{error}</div>
        ) : (
          <div ref={chartContainerRef} style={{ width: '100%', height: 300 }} />
        )}
      </div>
    </div>
  );
}
