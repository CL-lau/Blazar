import React, { useEffect, useState } from 'react';
import { callRouter } from './router.js';

const timingLabels = { event: 'Task intake', feishu: 'Feishu / Lark intake', qq: 'QQ intake', model: 'Model routing' };
const deliveryLabels = { weixin: 'WeChat', feishu: 'Feishu / Lark', wecom: 'WeCom', dingtalk: 'DingTalk', qq: 'QQ' };
const deliveryColumns = [
  ['pending', 'Pending'], ['sent', 'Sent'], ['failed', 'Failed'], ['unknown', 'Unknown'], ['expired', 'Expired'],
];

function duration(milliseconds) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(milliseconds) + ' ms';
}

export function RouterStatus({ token }) {
  const [reading, setReading] = useState(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let timer;
    async function load() {
      try {
        const data = await callRouter(token, '/admin/metrics', { signal: abort.signal });
        if (!abort.signal.aborted) {
          setReading({ data, time: Date.now() });
          setError('');
        }
      } catch (failure) {
        if (!abort.signal.aborted) setError(failure.message);
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(load, 10_000);
      }
    }
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [token, refresh]);

  const data = reading?.data;
  const timings = data ? [
    ['Queue to dispatch', data.queueLatencyMs],
    ...Object.entries(data.latencyMs ?? {}).map(([key, value]) => [timingLabels[key] ?? key, value]),
  ].filter(([, value]) => value?.count > 0) : [];
  return <section className="detail router-status">
    <h2>Router status</h2>
    <button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh</button>
    {reading && <small>Updated {new Date(reading.time).toLocaleTimeString()}</small>}
    {error && <p role="alert" className="error">{error}</p>}
    {!data && !error && <p role="status">Loading Router status…</p>}
    {data && <>
      <section>
        <h3>Execution devices</h3>
        <p>{data.devices.online} online · {data.devices.active} registered · {data.devices.interrupted} interrupted</p>
      </section>
      <section>
        <h3>Latency</h3>
        {timings.length === 0 ? <p>No latency samples yet.</p> : <div className="status-table">
          <table aria-label="Router latency">
            <thead><tr><th scope="col">Operation</th><th scope="col">Samples</th><th scope="col">Mean</th><th scope="col">p95 upper bound</th></tr></thead>
            <tbody>{timings.map(([label, value]) => <tr key={label}>
              <th scope="row">{label}</th><td>{value.count}</td><td>{duration(value.mean)}</td>
              <td>{value.p95UpperBound === null ? 'Outside measured range' : duration(value.p95UpperBound)}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      </section>
      <section>
        <h3>Channel delivery</h3>
        {!data.channelDelivery?.length ? <p>No channel deliveries yet.</p> : <div className="status-table">
          <table aria-label="Channel delivery outcomes">
            <thead><tr><th scope="col">Channel</th>{deliveryColumns.map(([key, label]) =>
              <th key={key} scope="col">{label}</th>)}</tr></thead>
            <tbody>{data.channelDelivery.map(row => <tr key={row.channel}>
              <th scope="row">{deliveryLabels[row.channel] ?? row.channel}</th>
              {deliveryColumns.map(([key]) => <td key={key}>{row[key]}</td>)}
            </tr>)}</tbody>
          </table>
        </div>}
      </section>
    </>}
  </section>;
}
