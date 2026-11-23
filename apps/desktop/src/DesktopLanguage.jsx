import React, { createContext, useContext, useEffect, useState } from 'react';

const languageKey = 'blazar.desktop.language';
const Language = createContext(null);

export function DesktopLanguage({ children }) {
  const [language, setLanguage] = useState(() => {
    try { return localStorage.getItem(languageKey) === 'zh' ? 'zh' : 'en'; }
    catch { return 'en'; }
  });
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-Hans' : 'en';
    try { localStorage.setItem(languageKey, language); } catch { /* Storage may be unavailable. */ }
  }, [language]);
  function t(english, chinese) {
    if (language !== 'zh') return english;
    return chinese ?? (Object.hasOwn(messages, english) ? messages[english] : english);
  }
  return <Language.Provider value={{ language, setLanguage, t }}>{children}</Language.Provider>;
}

export function useDesktopLanguage() {
  return useContext(Language);
}

export function LanguagePicker() {
  const { language, setLanguage, t } = useDesktopLanguage();
  return <select className="desktop-language" aria-label={t('Interface language', '界面语言')}
    value={language} onChange={event => setLanguage(event.target.value)}>
    <option value="en" lang="en">English</option>
    <option value="zh" lang="zh-Hans">简体中文</option>
  </select>;
}

const messages = {
  Operations: '任务', Resources: '资源', System: '系统',
  'Run desk': '任务台', 'Work items': '任务看板', Notifications: '通知',
  Applications: '应用', Wiki: '知识库', Schedules: '计划任务', Agents: '执行 Agent',
  Desktop: '桌面', 'Router status': '路由状态', 'Linked phones': '已关联手机', 'Connected tools': '已连接工具',
  'Execution devices': '执行设备', 'Desktop control': '桌面控制', 'Local Agents': '本地 Agent',
  'Revise Wiki page': '修订知识库页面', 'New task': '新建任务',
  Queue: '待执行', Execution: '执行', Decision: '待处理', Outcome: '已结束',
  'Connected apps': '已连接应用', Documents: '文档', Memory: '记忆',
  Development: '开发', 'Custom sources': '自定义来源',
  'Repository files and Markdown.': '仓库文件与 Markdown。',
  'Documents from Feishu workspaces.': '飞书工作区文档。',
  'Documents from Lark workspaces.': 'Lark 工作区文档。',
  'Documents and resources from an MCP server.': 'MCP 服务提供的文档与资源。',
  'Application source accounts.': '应用来源账号。',
  'To do': '待办', 'In progress': '进行中', Done: '已完成', Closed: '已关闭',
  Workspace: '工作区', 'All workspaces': '所有工作区', All: '全部',
  'Manage accounts, documents, and memory available to your workspaces.': '管理工作区可用的账号、文档和记忆。',
  'Review approvals, results, and failures that need your attention.': '查看需要你处理的审批、结果和失败。',
  'Register Workers, manage assignments, and set workspace policies.': '注册执行 Worker、管理分配并配置工作区策略。',
  'Choose a device and application before inspecting its windows.': '选择设备和应用，然后检查窗口。',
  'Manage phones authorized to review tasks and approvals.': '管理有权查看任务和审批的手机。',
  'Set the local addresses for your T3 Code and Linger workspaces.': '配置 T3 Code 和 Linger 工作区的本地地址。',
  'Discover and register installed Agent runtimes on this Mac.': '发现并注册此 Mac 已安装的 Agent 运行环境。',
  'Local Router diagnostics': '本地路由诊断',
  'Approval required': '需要批准', 'Result ready for review': '结果待验收',
  'Task failed': '任务失败', 'Waiting for an eligible device': '正在等待合适的执行设备',
  'Needs your attention': '需要你处理',
};

const statuses = {
  queued: '排队中', waiting_dependency: '等待前置任务', waiting_device: '等待执行设备',
  running: '执行中', pausing: '正在暂停', paused: '已暂停', cancelling: '正在取消',
  waiting_user: '等待用户', waiting_review: '等待验收', succeeded: '已完成',
  failed: '失败', cancelled: '已取消',
};
export function desktopStatus(t, status) {
  return t(status.replaceAll('_', ' '), statuses[status]);
}
