import { useDesktopLanguage } from './DesktopLanguage.jsx';
import { PageHeading } from './PageHeading.jsx';
import React, { useEffect, useState } from 'react';
import { callRouter } from './router.js';

const timingLabels = { event: 'Task intake', feishu: 'Feishu intake', lark: 'Lark intake', qq: 'QQ intake', model: 'Model routing' };
const deliveryLabels = { weixin: 'WeChat', feishu: 'Feishu', lark: 'Lark', wecom: 'WeCom', dingtalk: 'DingTalk', qq: 'QQ' };
const connectionLabels = { starting: 'Starting', available: 'Available', unavailable: 'Unavailable' };
const deliveryColumns = [
  ['pending', 'Pending'], ['sent', 'Sent'], ['failed', 'Failed'], ['unknown', 'Unknown'], ['expired', 'Expired'],
];

function duration(milliseconds) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(milliseconds) + ' ms';
}

export function RouterStatus({ token }) {
  const { t } = useDesktopLanguage();
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
    <PageHeading title="Router status" description={reading ? 'Updated ' + new Date(reading.time).toLocaleTimeString() : 'Local Router diagnostics'}
      actions={<button type="button" onClick={() => setRefresh(value => value + 1)}>{t('Refresh status', '刷新状态')}</button>} />
    {error && <p role="alert" className="error">{error}</p>}
    {!data && !error && <p role="status">Loading Router status…</p>}
    {data && <>
      <section className="diagnostics-summary" aria-label="Execution devices">
        <div><span>{t('Devices online', '在线设备')}</span><strong>{data.devices.online}</strong></div>
        <div><span>{t('Registered', '已登记')}</span><strong>{data.devices.active}</strong></div>
        <div><span>{t('Interrupted', '中断')}</span><strong>{data.devices.interrupted}</strong></div>
      </section>
      {data.runRecovery && <section>
        <h3>{t('Run recovery', '运行恢复')}</h3>
        <p>{data.runRecovery.leaseExpired} expired leases · {data.runRecovery.deadlineExceeded} run timeouts · {data.runRecovery.deviceInterrupted} device interruptions · {data.runRecovery.deviceRevoked} runs stopped by device revocation</p>
      </section>}
      {data.modelTokens?.samples > 0 && <section>
        <h3>{t('Routing model tokens', '路由模型令牌')}</h3>
        <p>{data.modelTokens.totalTokens.toLocaleString()} total across {data.modelTokens.samples} reported model calls since Router startup</p>
      </section>}
      <section>
        <h3>{t('Latency', '延迟')}</h3>
        {timings.length === 0 ? <p>No latency samples yet.</p> : <div className="status-table">
          <table aria-label="Router latency">
            <thead><tr><th scope="col">{t('Operation', '操作')}</th><th scope="col">{t('Samples', '采样数')}</th><th scope="col">{t('Mean', '均值')}</th><th scope="col">p95 upper bound</th></tr></thead>
            <tbody>{timings.map(([label, value]) => <tr key={label}>
              <th scope="row">{label}</th><td>{value.count}</td><td>{duration(value.mean)}</td>
              <td>{value.p95UpperBound === null ? 'Outside measured range' : duration(value.p95UpperBound)}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      </section>
      {data.stream && <section>
        <h3>{t('Client event streams', '客户端事件流')}</h3>
        <p>{data.stream.opened} opened · {data.stream.replayedEvents} events replayed · {data.stream.resnapshotRequired} snapshot refreshes required</p>
      </section>}
      {data.channels && <section>
        <h3>{t('IM configuration', '即时通讯配置')}</h3>
        <div className="status-table">
          <table aria-label="IM channel configuration">
            <thead><tr><th scope="col">{t('Channel', '渠道')}</th><th scope="col">{t('Workspace', '工作区')}</th><th scope="col">{t('Receive', '接收')}</th><th scope="col">{t('Reply', '回复')}</th><th scope="col">{t('Connection', '连接')}</th></tr></thead>
            <tbody>{data.channels.map(channel => <tr key={channel.id}>
              <th scope="row">{deliveryLabels[channel.id] ?? channel.id}</th>
              <td>{channel.workspace ?? '—'}</td>
              <td>{channel.inbound ? 'Configured' : 'Disabled'}</td>
              <td>{channel.outbound ? 'Configured' : 'Disabled'}</td>
              <td>{connectionLabels[channel.health] ?? '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>}
      <section>
        <h3>{t('Channel delivery', '渠道投递')}</h3>
        {!data.channelDelivery?.length ? <p>No channel deliveries yet.</p> : <div className="status-table">
          <table aria-label="Channel delivery outcomes">
            <thead><tr><th scope="col">{t('Channel', '渠道')}</th>{deliveryColumns.map(([key, label]) =>
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
