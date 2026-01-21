'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { useRouter } from 'next/navigation';
import { LoadingKilat } from '@/components/ui/LoadingKilat';
import { DailyTrafficChart, ModelUsageChart, TierDistributionChart } from '@/components/admin/AnalyticsCharts';

// Types
interface DailyStats { date: string; total_requests: number; successful_requests: number; total_cost_usd: number; unique_users: number; }
interface ModelStats { model_used: string; usage_count: number; total_cost: number; avg_quality: number; }
interface TierBreakdown { tier: string; user_count: number; total_spent: number; }
interface AgentStats { agent_type: string; total_requests: number; successful: number; success_rate: number; total_cost: number; }
interface LLMModel { model_id: string; display_name: string; provider: string; model_type: string; tier_required: string; is_active: boolean; cost_per_request: string; priority: number; }
interface TierLimit { id: string; tier: string; agent_id: string; limit_daily: number; limit_monthly: number; max_daily_cost_usd: string; enabled: boolean; }
interface Summary { todayRequests: number; todayCost: number; todayUsers: number; totalUsers: number; }
interface SecurityAlert { id: string; event_type: string; user_id?: string; severity: string; details: any; created_at: string; }
interface RequestTrace { id: string; job_id: string; session_id?: string; user_id?: string; agent_type: string; mode?: string; prompt_preview?: string; steps: any[]; status: string; total_duration_ms?: number; cache_hits: number; cache_misses: number; error_message?: string; created_at: string; }
interface TraceStats { todayTotal: number; todaySuccess: number; todayErrors: number; avgDuration: number; totalCacheHits: number; totalCacheMisses: number; }

type TabId = 'overview' | 'models' | 'tiers' | 'settings' | 'security' | 'traces';

export default function AdminPage() {
    const { user } = useAuth();
    const router = useRouter();

    const [activeTab, setActiveTab] = useState<TabId>('overview');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Data states
    const [dailyStats, setDailyStats] = useState<DailyStats[]>([]);
    const [modelStats, setModelStats] = useState<ModelStats[]>([]);
    const [tierBreakdown, setTierBreakdown] = useState<TierBreakdown[]>([]);
    const [agentStats, setAgentStats] = useState<AgentStats[]>([]);
    const [summary, setSummary] = useState<Summary>({ todayRequests: 0, todayCost: 0, todayUsers: 0, totalUsers: 0 });
    const [models, setModels] = useState<LLMModel[]>([]);
    const [tierLimits, setTierLimits] = useState<TierLimit[]>([]);
    const [editingModel, setEditingModel] = useState<LLMModel | null>(null);
    const [editingTier, setEditingTier] = useState<TierLimit | null>(null);
    const [appConfigs, setAppConfigs] = useState<any[]>([]);
    const [editingConfig, setEditingConfig] = useState<any | null>(null);
    const [securityAlerts, setSecurityAlerts] = useState<SecurityAlert[]>([]);
    const [securitySummary, setSecuritySummary] = useState<any>({});
    const [traces, setTraces] = useState<RequestTrace[]>([]);
    const [traceStats, setTraceStats] = useState<TraceStats>({ todayTotal: 0, todaySuccess: 0, todayErrors: 0, avgDuration: 0, totalCacheHits: 0, totalCacheMisses: 0 });
    const [expandedTrace, setExpandedTrace] = useState<string | null>(null);

    // Fetch all data
    useEffect(() => {
        const loadData = async () => {
            setLoading(true);
            try {
                // Fetch analytics
                const analyticsRes = await fetch('/api/admin/analytics');
                if (analyticsRes.status === 401) { setError('Admin access required'); return; }
                if (analyticsRes.ok) {
                    const data = await analyticsRes.json();
                    setSummary(data.summary || {});
                    setDailyStats(data.dailyStats || []);
                    setModelStats(data.modelStats || []);
                    setTierBreakdown(data.tierBreakdown || []);
                    setAgentStats(data.agentStats || []);
                }

                // Fetch models
                const modelsRes = await fetch('/api/admin/models');
                if (modelsRes.ok) setModels((await modelsRes.json()).models || []);

                // Fetch tier limits
                const tiersRes = await fetch('/api/admin/tiers');
                if (tiersRes.ok) setTierLimits((await tiersRes.json()).tierLimits || []);

                // Fetch app configs
                const configsRes = await fetch('/api/admin/configs');
                if (configsRes.ok) setAppConfigs((await configsRes.json()).configs || []);

                // Fetch security
                const securityRes = await fetch('/api/admin/security');
                if (securityRes.ok) {
                    const data = await securityRes.json();
                    setSecurityAlerts(data.alerts || []);
                    setSecuritySummary(data.summary || {});
                }

                // Fetch traces
                const tracesRes = await fetch('/api/admin/traces');
                if (tracesRes.ok) {
                    const data = await tracesRes.json();
                    setTraces(data.traces || []);
                    setTraceStats(data.stats || { todayTotal: 0, todaySuccess: 0, todayErrors: 0, avgDuration: 0, totalCacheHits: 0, totalCacheMisses: 0 });
                }
            } catch (err) { console.error('Load error:', err); }
            setLoading(false);
        };
        loadData();
    }, []);

    // Update handlers
    const updateModel = async (model: LLMModel) => {
        const res = await fetch('/api/admin/models', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(model) });
        if (res.ok) { setModels((await (await fetch('/api/admin/models')).json()).models || []); setEditingModel(null); }
    };

    const updateTier = async (tier: TierLimit) => {
        const res = await fetch('/api/admin/tiers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tier) });
        if (res.ok) { setTierLimits((await (await fetch('/api/admin/tiers')).json()).tierLimits || []); setEditingTier(null); }
    };

    const updateConfig = async (config: any) => {
        const res = await fetch('/api/admin/configs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
        if (res.ok) { setAppConfigs((await (await fetch('/api/admin/configs')).json()).configs || []); setEditingConfig(null); }
    };

    if (error) {
        return (
            <div className="min-h-screen bg-background-dark flex items-center justify-center">
                <div className="glass p-8 rounded-2xl text-center">
                    <span className="material-symbols-outlined text-5xl text-red-500 mb-4 block">error</span>
                    <h1 className="text-2xl font-bold text-white mb-2">Access Denied</h1>
                    <p className="text-gray-400 mb-6">{error}</p>
                    <button onClick={() => router.push('/chat')} className="btn-premium">Back to Chat</button>
                </div>
            </div>
        );
    }

    const tabs = [
        { id: 'overview', label: 'Overview', icon: 'dashboard' },
        { id: 'models', label: 'Models', icon: 'smart_toy' },
        { id: 'tiers', label: 'Tier Limits', icon: 'tune' },
        { id: 'settings', label: 'Settings', icon: 'settings' },
        { id: 'security', label: 'Security', icon: 'shield' },
        { id: 'traces', label: 'Traces', icon: 'timeline' },
    ];

    return (
        <div className="min-h-screen bg-background-dark text-white">
            {/* Header */}
            <header className="glass-header border-b border-white/10 px-6 py-4">
                <div className="max-w-7xl mx-auto flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-2xl text-primary">admin_panel_settings</span>
                        <h1 className="text-xl font-bold gradient-text">Admin Dashboard</h1>
                    </div>
                    <button onClick={() => router.push('/chat')} className="text-sm text-gray-400 hover:text-white flex items-center gap-1">
                        <span className="material-symbols-outlined text-lg">arrow_back</span> Back
                    </button>
                </div>
            </header>

            {/* Tabs */}
            <nav className="border-b border-white/10 px-6 overflow-x-auto">
                <div className="max-w-7xl mx-auto flex gap-1">
                    {tabs.map((tab) => (
                        <button key={tab.id} onClick={() => setActiveTab(tab.id as TabId)}
                            className={`px-4 py-3 flex items-center gap-2 text-sm font-medium transition-colors border-b-2 whitespace-nowrap ${activeTab === tab.id ? 'border-primary text-primary' : 'border-transparent text-gray-400 hover:text-white'
                                }`}>
                            <span className="material-symbols-outlined text-lg">{tab.icon}</span>
                            {tab.label}
                        </button>
                    ))}
                </div>
            </nav>

            {/* Content */}
            <main className="max-w-7xl mx-auto p-6">
                {loading ? (
                    <div className="flex items-center justify-center py-20"><LoadingKilat /></div>
                ) : (
                    <>
                        {/* Overview Tab */}
                        {activeTab === 'overview' && (
                            <div className="space-y-6 animate-fade-in">
                                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                                    <StatCard icon="trending_up" label="Today's Requests" value={summary.todayRequests} color="purple" />
                                    <StatCard icon="payments" label="Today's Cost" value={`$${(summary.todayCost || 0).toFixed(4)}`} color="cyan" />
                                    <StatCard icon="person" label="Active Users" value={summary.todayUsers} color="pink" />
                                    <StatCard icon="group" label="Total Users" value={summary.totalUsers} color="blue" />
                                </div>
                                {/* Charts Section */}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="glass p-6 rounded-2xl">
                                        <h3 className="text-lg font-semibold mb-4">Traffic & Users (30 Days)</h3>
                                        {dailyStats.length > 0 ? (
                                            <DailyTrafficChart data={dailyStats} />
                                        ) : (
                                            <div className="h-[300px] flex items-center justify-center text-gray-500">No traffic data yet</div>
                                        )}
                                    </div>
                                    <div className="glass p-6 rounded-2xl">
                                        <h3 className="text-lg font-semibold mb-4">User Distribution</h3>
                                        {tierBreakdown.length > 0 ? (
                                            <TierDistributionChart data={tierBreakdown} />
                                        ) : (
                                            <div className="h-[300px] flex items-center justify-center text-gray-500">No user data yet</div>
                                        )}
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="glass rounded-2xl p-6">
                                        <h3 className="text-lg font-semibold mb-4">Top AI Models By Usage</h3>
                                        {modelStats.length > 0 ? (
                                            <ModelUsageChart data={modelStats} />
                                        ) : (
                                            <div className="h-[300px] flex items-center justify-center text-gray-500">No model usage data</div>
                                        )}
                                    </div>
                                    <div className="glass rounded-2xl p-6">
                                        <h3 className="text-lg font-semibold mb-4">Agent Performance</h3>
                                        <div className="space-y-2 max-h-[300px] overflow-y-auto scrollbar-custom">
                                            {agentStats.map((a) => (
                                                <div key={a.agent_type} className="flex items-center justify-between p-3 rounded-lg bg-white/5 text-sm hover:bg-white/10 transition-colors">
                                                    <span className="capitalize font-medium">{a.agent_type}</span>
                                                    <div className="flex items-center gap-4">
                                                        <span className="text-gray-400">{a.total_requests} reqs</span>
                                                        <span className={`font-bold ${a.success_rate >= 90 ? 'text-green-400' : a.success_rate >= 70 ? 'text-yellow-400' : 'text-red-400'}`}>{a.success_rate}% Success</span>
                                                    </div>
                                                </div>
                                            ))}
                                            {agentStats.length === 0 && <p className="text-center text-gray-500 py-10">No agent data recorded</p>}
                                        </div>
                                    </div>
                                </div>

                                {/* Raw Stats Table */}
                                <div className="glass rounded-2xl p-6">
                                    <h3 className="text-lg font-semibold mb-4">Top Models Details</h3>
                                    <table className="w-full text-sm">
                                        <thead><tr className="text-left text-gray-400 border-b border-white/10"><th className="pb-3">Model</th><th className="pb-3 text-right">Usage</th><th className="pb-3 text-right">Cost</th></tr></thead>
                                        <tbody>
                                            {modelStats.slice(0, 8).map((m) => (
                                                <tr key={m.model_used} className="border-b border-white/5">
                                                    <td className="py-2 font-mono text-primary">{m.model_used}</td>
                                                    <td className="py-2 text-right">{m.usage_count}</td>
                                                    <td className="py-2 text-right">${parseFloat(m.total_cost?.toString() || '0').toFixed(4)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {/* Models Tab */}
                        {activeTab === 'models' && (
                            <div className="space-y-6 animate-fade-in">
                                <h2 className="text-xl font-bold">LLM Models ({models.length})</h2>
                                <div className="glass rounded-2xl overflow-hidden">
                                    <table className="w-full text-sm">
                                        <thead className="bg-white/5"><tr className="text-left text-gray-400">
                                            <th className="p-4">Model ID</th><th className="p-4">Name</th><th className="p-4">Type</th>
                                            <th className="p-4">Tier</th><th className="p-4 text-right">Cost</th><th className="p-4 text-center">Active</th><th className="p-4">Edit</th>
                                        </tr></thead>
                                        <tbody>
                                            {models.map((m) => (
                                                <tr key={m.model_id} className="border-t border-white/5 hover:bg-white/5">
                                                    <td className="p-4 font-mono text-primary">{m.model_id}</td>
                                                    <td className="p-4">{m.display_name}</td>
                                                    <td className="p-4"><span className={`px-2 py-1 rounded text-xs ${m.model_type === 'image' ? 'bg-pink-500/20 text-pink-400' : 'bg-blue-500/20 text-blue-400'}`}>{m.model_type}</span></td>
                                                    <td className="p-4"><TierBadge tier={m.tier_required} /></td>
                                                    <td className="p-4 text-right font-mono">${parseFloat(m.cost_per_request).toFixed(4)}</td>
                                                    <td className="p-4 text-center"><span className={`material-symbols-outlined ${m.is_active ? 'text-green-400' : 'text-red-400'}`}>{m.is_active ? 'check_circle' : 'cancel'}</span></td>
                                                    <td className="p-4"><button onClick={() => setEditingModel(m)} className="p-2 rounded hover:bg-white/10"><span className="material-symbols-outlined text-primary">edit</span></button></td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                {editingModel && <Modal title={`Edit: ${editingModel.model_id}`} onClose={() => setEditingModel(null)}><ModelForm model={editingModel} onSave={updateModel} onCancel={() => setEditingModel(null)} /></Modal>}
                            </div>
                        )}

                        {/* Tier Limits Tab */}
                        {activeTab === 'tiers' && (
                            <div className="space-y-6 animate-fade-in">
                                <h2 className="text-xl font-bold">Tier Limits</h2>
                                {['free', 'pro', 'enterprise'].map((tier) => (
                                    <div key={tier} className="glass rounded-2xl p-6">
                                        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                                            <TierBadge tier={tier} />
                                            <span className="text-gray-400 text-sm">{tier === 'free' ? '($0)' : tier === 'pro' ? '($29/mo)' : '($149/mo)'}</span>
                                        </h3>
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                            {tierLimits.filter(t => t.tier === tier).map((limit) => (
                                                <div key={limit.id} className={`p-4 rounded-xl border ${limit.enabled ? 'border-white/10 bg-white/5' : 'border-red-500/30 bg-red-500/10'}`}>
                                                    <div className="flex items-center justify-between mb-3">
                                                        <span className="font-medium capitalize">{limit.agent_id}</span>
                                                        <button onClick={() => setEditingTier(limit)} className="p-1 rounded hover:bg-white/10"><span className="material-symbols-outlined text-sm text-primary">edit</span></button>
                                                    </div>
                                                    <div className="space-y-1 text-sm">
                                                        <div className="flex justify-between"><span className="text-gray-400">Daily</span><span className="font-mono">{limit.limit_daily}</span></div>
                                                        <div className="flex justify-between"><span className="text-gray-400">Monthly</span><span className="font-mono">{limit.limit_monthly}</span></div>
                                                        <div className="flex justify-between"><span className="text-gray-400">Max Cost</span><span className="text-accent-cyan font-mono">${parseFloat(limit.max_daily_cost_usd || '0').toFixed(2)}</span></div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                                {editingTier && <Modal title={`Edit: ${editingTier.tier} - ${editingTier.agent_id}`} onClose={() => setEditingTier(null)}><TierForm tier={editingTier} onSave={updateTier} onCancel={() => setEditingTier(null)} /></Modal>}
                            </div>
                        )}

                        {/* Settings Tab */}
                        {activeTab === 'settings' && (
                            <div className="space-y-6 animate-fade-in">
                                <h2 className="text-xl font-bold">App Configs ({appConfigs.length})</h2>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {appConfigs.map((config) => (
                                        <div key={config.id} className="glass rounded-xl p-4">
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="font-mono text-primary text-sm">{config.config_key}</span>
                                                <button onClick={() => setEditingConfig(config)} className="p-1 rounded hover:bg-white/10"><span className="material-symbols-outlined text-sm text-primary">edit</span></button>
                                            </div>
                                            <p className="text-xs text-gray-400 mb-2">{config.description || 'No description'}</p>
                                            <pre className="text-xs bg-black/20 rounded p-2 overflow-x-auto max-h-32">{JSON.stringify(config.config_value, null, 2)}</pre>
                                        </div>
                                    ))}
                                </div>
                                {editingConfig && <Modal title={`Edit: ${editingConfig.config_key}`} onClose={() => setEditingConfig(null)} wide><ConfigForm config={editingConfig} onSave={updateConfig} onCancel={() => setEditingConfig(null)} /></Modal>}
                            </div>
                        )}

                        {/* Security Tab */}
                        {activeTab === 'security' && (
                            <div className="space-y-6 animate-fade-in">
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <StatCard icon="warning" label="Security Alerts" value={securityAlerts.length} color="pink" />
                                    <StatCard icon="verified" label="Total Events" value={securitySummary.totalEvents || 0} color="blue" />
                                    <StatCard icon="health_and_safety" label="System Health" value="98%" color="cyan" />
                                </div>
                                <div className="glass rounded-2xl p-6">
                                    <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                                        <span className="material-symbols-outlined text-purple-400">shield</span>
                                        Recent Security Events
                                    </h3>
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-left text-sm">
                                            <thead><tr className="border-b border-white/10 text-gray-400">
                                                <th className="py-3 px-4">Timestamp</th><th className="py-3 px-4">Event</th><th className="py-3 px-4">User</th><th className="py-3 px-4">Severity</th><th className="py-3 px-4">Details</th>
                                            </tr></thead>
                                            <tbody>
                                                {securityAlerts.length === 0 ? (
                                                    <tr><td colSpan={5} className="py-8 text-center text-gray-500">No security alerts. System is secure.</td></tr>
                                                ) : securityAlerts.map((log) => (
                                                    <tr key={log.id} className="border-b border-white/5 hover:bg-white/5">
                                                        <td className="py-3 px-4 text-gray-400">{new Date(log.created_at).toLocaleString()}</td>
                                                        <td className="py-3 px-4 font-medium text-white">{log.event_type}</td>
                                                        <td className="py-3 px-4 text-gray-400 font-mono text-xs">{log.user_id ? log.user_id.substring(0, 8) + '...' : 'System'}</td>
                                                        <td className="py-3 px-4"><SeverityBadge severity={log.severity} /></td>
                                                        <td className="py-3 px-4 text-gray-400 max-w-xs truncate">{JSON.stringify(log.details)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Traces Tab */}
                        {activeTab === 'traces' && (
                            <div className="space-y-6 animate-fade-in">
                                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                                    <StatCard icon="timeline" label="Today's Traces" value={traceStats.todayTotal} color="purple" />
                                    <StatCard icon="check_circle" label="Successful" value={traceStats.todaySuccess} color="cyan" />
                                    <StatCard icon="error" label="Errors" value={traceStats.todayErrors} color="pink" />
                                    <StatCard icon="speed" label="Avg Duration" value={`${Math.round(traceStats.avgDuration / 1000 * 10) / 10}s`} color="blue" />
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div className="glass rounded-xl p-4">
                                        <div className="flex items-center gap-2 text-green-400">
                                            <span className="material-symbols-outlined">cached</span>
                                            <span>Cache Hits</span>
                                        </div>
                                        <p className="text-2xl font-bold mt-2">{traceStats.totalCacheHits}</p>
                                    </div>
                                    <div className="glass rounded-xl p-4">
                                        <div className="flex items-center gap-2 text-orange-400">
                                            <span className="material-symbols-outlined">storage</span>
                                            <span>Cache Misses</span>
                                        </div>
                                        <p className="text-2xl font-bold mt-2">{traceStats.totalCacheMisses}</p>
                                    </div>
                                </div>

                                <div className="glass rounded-2xl p-6">
                                    <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                                        <span className="material-symbols-outlined text-purple-400">timeline</span>
                                        Recent Request Traces
                                    </h3>
                                    <div className="space-y-2 max-h-[500px] overflow-y-auto scrollbar-custom">
                                        {traces.length === 0 ? (
                                            <p className="text-center text-gray-500 py-10">No traces recorded yet. Make some requests to see traces.</p>
                                        ) : traces.slice(0, 50).map((trace) => (
                                            <div key={trace.id} className="border border-white/10 rounded-lg overflow-hidden">
                                                <button
                                                    onClick={() => setExpandedTrace(expandedTrace === trace.id ? null : trace.id)}
                                                    className="w-full p-3 flex items-center justify-between hover:bg-white/5 transition-colors"
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <span className={`material-symbols-outlined ${trace.status === 'success' ? 'text-green-400' : trace.status === 'error' ? 'text-red-400' : 'text-yellow-400'}`}>
                                                            {trace.status === 'success' ? 'check_circle' : trace.status === 'error' ? 'error' : 'pending'}
                                                        </span>
                                                        <span className="font-mono text-xs text-gray-400">{trace.job_id.substring(0, 8)}...</span>
                                                        <span className="text-primary">{trace.agent_type}</span>
                                                        <span className="text-xs px-2 py-0.5 rounded bg-white/10">{trace.mode}</span>
                                                    </div>
                                                    <div className="flex items-center gap-4 text-sm">
                                                        <span className="text-gray-400">{trace.total_duration_ms ? `${(trace.total_duration_ms / 1000).toFixed(1)}s` : '-'}</span>
                                                        <span className="text-green-400">{trace.cache_hits} hits</span>
                                                        <span className="text-orange-400">{trace.cache_misses} miss</span>
                                                        <span className="text-gray-500">{new Date(trace.created_at).toLocaleTimeString()}</span>
                                                        <span className="material-symbols-outlined text-gray-400">
                                                            {expandedTrace === trace.id ? 'expand_less' : 'expand_more'}
                                                        </span>
                                                    </div>
                                                </button>
                                                {expandedTrace === trace.id && (
                                                    <div className="p-4 bg-black/30 border-t border-white/10">
                                                        <p className="text-xs text-gray-400 mb-3 truncate">Prompt: {trace.prompt_preview}</p>
                                                        {trace.error_message && (
                                                            <p className="text-xs text-red-400 mb-3">Error: {trace.error_message}</p>
                                                        )}
                                                        <div className="space-y-1">
                                                            {(trace.steps || []).map((step: any, idx: number) => (
                                                                <div key={idx} className="flex items-center gap-2 text-xs">
                                                                    <span className="text-gray-500 w-16">{step.duration_ms || 0}ms</span>
                                                                    <span className={`w-28 ${step.result === 'hit' ? 'text-green-400' : step.result === 'miss' ? 'text-orange-400' : step.result === 'error' ? 'text-red-400' : 'text-gray-300'}`}>
                                                                        {step.step}
                                                                    </span>
                                                                    <span className="text-gray-400">{step.result}</span>
                                                                    {step.details && <span className="text-gray-600 truncate max-w-xs">{JSON.stringify(step.details)}</span>}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </main>
        </div>
    );
}

// UI Components
function StatCard({ icon, label, value, color }: { icon: string; label: string; value: string | number; color: string }) {
    const colors: Record<string, string> = { purple: 'from-purple-500 to-pink-500', cyan: 'from-cyan-500 to-blue-500', pink: 'from-pink-500 to-rose-500', blue: 'from-blue-500 to-indigo-500' };
    return (
        <div className="glass rounded-xl p-5">
            <div className="flex items-center gap-3 mb-2">
                <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${colors[color]} flex items-center justify-center`}><span className="material-symbols-outlined text-white">{icon}</span></div>
                <span className="text-gray-400 text-sm">{label}</span>
            </div>
            <p className="text-2xl font-bold">{value}</p>
        </div>
    );
}

function TierBadge({ tier }: { tier: string }) {
    return <span className={`px-2 py-1 rounded text-xs font-bold uppercase ${tier === 'enterprise' ? 'bg-gradient-to-r from-purple-500 to-pink-500' : tier === 'pro' ? 'bg-primary' : 'bg-gray-600'}`}>{tier}</span>;
}

function SeverityBadge({ severity }: { severity: string }) {
    const cls = severity === 'critical' ? 'bg-red-500/20 text-red-400 border-red-500/50' : severity === 'error' ? 'bg-orange-500/20 text-orange-400 border-orange-500/50' : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50';
    return <span className={`px-2 py-1 rounded text-xs font-bold border ${cls}`}>{severity.toUpperCase()}</span>;
}

function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
            <div className={`glass rounded-2xl p-6 m-4 ${wide ? 'w-full max-w-lg' : 'w-full max-w-md'}`} onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-bold mb-4">{title}</h3>
                {children}
            </div>
        </div>
    );
}

function ModelForm({ model, onSave, onCancel }: { model: LLMModel; onSave: (m: LLMModel) => void; onCancel: () => void }) {
    const [form, setForm] = useState(model);
    return (
        <div className="space-y-4">
            <div><label className="block text-sm text-gray-400 mb-1">Display Name</label><input type="text" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} className="input-premium w-full" /></div>
            <div><label className="block text-sm text-gray-400 mb-1">Tier Required</label><select value={form.tier_required} onChange={(e) => setForm({ ...form, tier_required: e.target.value })} className="input-premium w-full"><option value="free">Free</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></select></div>
            <div><label className="block text-sm text-gray-400 mb-1">Cost per Request ($)</label><input type="number" step="0.0001" value={form.cost_per_request} onChange={(e) => setForm({ ...form, cost_per_request: e.target.value })} className="input-premium w-full" /></div>
            <div className="flex items-center gap-2"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /><label className="text-sm text-gray-400">Active</label></div>
            <div className="flex gap-3"><button onClick={onCancel} className="flex-1 px-4 py-2 rounded-lg border border-white/20 hover:bg-white/10">Cancel</button><button onClick={() => onSave(form)} className="flex-1 btn-premium">Save</button></div>
        </div>
    );
}

function TierForm({ tier, onSave, onCancel }: { tier: TierLimit; onSave: (t: TierLimit) => void; onCancel: () => void }) {
    const [form, setForm] = useState(tier);
    return (
        <div className="space-y-4">
            <div><label className="block text-sm text-gray-400 mb-1">Daily Limit</label><input type="number" value={form.limit_daily} onChange={(e) => setForm({ ...form, limit_daily: parseInt(e.target.value) })} className="input-premium w-full" /></div>
            <div><label className="block text-sm text-gray-400 mb-1">Monthly Limit</label><input type="number" value={form.limit_monthly} onChange={(e) => setForm({ ...form, limit_monthly: parseInt(e.target.value) })} className="input-premium w-full" /></div>
            <div><label className="block text-sm text-gray-400 mb-1">Max Daily Cost ($)</label><input type="number" step="0.01" value={form.max_daily_cost_usd} onChange={(e) => setForm({ ...form, max_daily_cost_usd: e.target.value })} className="input-premium w-full" /></div>
            <div className="flex items-center gap-2"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /><label className="text-sm text-gray-400">Enabled</label></div>
            <div className="flex gap-3"><button onClick={onCancel} className="flex-1 px-4 py-2 rounded-lg border border-white/20 hover:bg-white/10">Cancel</button><button onClick={() => onSave(form)} className="flex-1 btn-premium">Save</button></div>
        </div>
    );
}

function ConfigForm({ config, onSave, onCancel }: { config: any; onSave: (c: any) => void; onCancel: () => void }) {
    const [form, setForm] = useState(config);
    const [jsonValue, setJsonValue] = useState(JSON.stringify(config.config_value, null, 2));
    const [jsonError, setJsonError] = useState<string | null>(null);
    const handleSave = () => { try { onSave({ ...form, config_value: JSON.parse(jsonValue) }); } catch (e) { setJsonError('Invalid JSON'); } };
    return (
        <div className="space-y-4">
            <div><label className="block text-sm text-gray-400 mb-1">Description</label><input type="text" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} className="input-premium w-full" /></div>
            <div><label className="block text-sm text-gray-400 mb-1">Value (JSON)</label><textarea value={jsonValue} onChange={(e) => { setJsonValue(e.target.value); setJsonError(null); }} className="input-premium w-full h-48 font-mono text-xs" />{jsonError && <p className="text-red-400 text-xs mt-1">{jsonError}</p>}</div>
            <div className="flex gap-3"><button onClick={onCancel} className="flex-1 px-4 py-2 rounded-lg border border-white/20 hover:bg-white/10">Cancel</button><button onClick={handleSave} className="flex-1 btn-premium">Save</button></div>
        </div>
    );
}
