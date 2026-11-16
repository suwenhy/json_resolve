/**
 * Curated sample datasets demonstrating Tree Inspector, Graph Visualizer, Table View,
 * CodeGen, Smart Repair, and Structural Diff.
 */

// Pre-encoded demo JWT: header {"alg":"HS256","typ":"JWT"}, payload {"sub":"usr_9081","name":"Linus Chen","role":"platform_admin","iat":1731740400,"exp":1893456000}
const DEMO_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3JfOTA4MSIsIm5hbWUiOiJMaW51cyBDaGVuIiwicm9sZSI6InBsYXRmb3JtX2FkbWluIiwiaWF0IjoxNzMxNzQwNDAwLCJleHAiOjE4OTM0NTYwMDB9.JSONLensDemoSig_9x8A7b6C5d';

export const DEFAULT_JSON_OBJ = {
  code: 200,
  message: 'success',
  trace_id: 'tr_8f92a1c4e7b04d12',
  server_time: 1763276776,
  service: {
    name: 'order-gateway-prod',
    region: 'ap-shanghai-2',
    version: 'v2.14.0',
    healthy: true,
    dashboard_url: 'https://grafana.internal.example.com/d/order-gw?orgId=1&refresh=10s',
    brand_color: '#6366f1',
  },
  auth: {
    token_type: 'Bearer',
    access_token: DEMO_JWT,
    scopes: ['orders:read', 'orders:write', 'metrics:export'],
  },
  pagination: {
    page: 1,
    page_size: 20,
    total_items: 4,
  },
  orders: [
    {
      order_id: 'ORD-20261116-001',
      customer: '张伟 (Wei Zhang)',
      plan: 'Enterprise Annual',
      amount: 12800.0,
      currency: 'CNY',
      paid: true,
      created_at: '2026-11-16T14:22:10+08:00',
      tags: ['vip', 'invoice-issued'],
    },
    {
      order_id: 'ORD-20261116-002',
      customer: 'Sarah Jenkins',
      plan: 'Team Pro',
      amount: 2499.5,
      currency: 'CNY',
      paid: true,
      created_at: '2026-11-16T14:38:05+08:00',
      tags: ['renewal'],
    },
    {
      order_id: 'ORD-20261116-003',
      customer: '李明 (Ming Li)',
      plan: 'Developer Plus',
      amount: 599.0,
      currency: 'CNY',
      paid: false,
      created_at: '2026-11-16T14:51:42+08:00',
      tags: ['pending-payment', 'coupon'],
    },
    {
      order_id: 'ORD-20261116-004',
      customer: 'CloudMatrix Ltd.',
      plan: 'Dedicated Cluster',
      amount: 48000.0,
      currency: 'CNY',
      paid: true,
      created_at: '2026-11-16T15:02:19+08:00',
      tags: ['vip', 'sla-99.99'],
    },
  ],
  ext_payload: '{"ab_bucket":"checkout_v3","feature_flags":{"instant_refund":true,"max_retry":3}}',
};

export const SAMPLES = [
  {
    id: 'microservice-api',
    title: '微服务订单网关响应',
    subtitle: '含 JWT 令牌、时间戳、颜色值、表格数组与内嵌 JSON',
    content: JSON.stringify(DEFAULT_JSON_OBJ, null, 2),
  },
  {
    id: 'broken-json-demo',
    title: '非标准 / 损坏的 JSON (智能修复演示)',
    subtitle: '包含注释、单引号、未加引号键名、Python True/None、尾随逗号',
    content: `// 从服务端日志或浏览器控制台直接粘贴的非标准格式
jsonpCallback({
  env: 'production',
  node_id: 'worker-sh-04',
  retry_enabled: True,     // Python 布尔字面量
  fallback_host: None,     // Python 空值
  latency_ms: +42.8,
  theme_accent: '#10b981',
  endpoints: [
    'https://api.example.com/v2/health',
    'https://api.example.com/v2/metrics', // 尾随逗号
  ],
  maintainer: {
    name: '陈工',
    role: 'SRE Lead',
  },
});`,
  },
  {
    id: 'architecture-graph',
    title: '云原生集群拓扑配置',
    subtitle: '适合体验「图谱视图 (Graph)」与「JSONPath 深度查询」',
    content: JSON.stringify(
      {
        cluster: 'k8s-prod-cn-east',
        version: '1.31.2',
        ingress: {
          gateway: 'envoy-edge',
          tls_enabled: true,
          domains: ['json.example.com', 'api.example.com'],
        },
        workloads: [
          {
            name: 'api-server',
            replicas: 6,
            cpu_limit: '2000m',
            memory_limit: '4Gi',
            autoscaling: { min: 3, max: 16, target_cpu_pct: 70 },
          },
          {
            name: 'worker-queue',
            replicas: 4,
            cpu_limit: '4000m',
            memory_limit: '8Gi',
            autoscaling: { min: 2, max: 12, target_cpu_pct: 75 },
          },
          {
            name: 'redis-sentinel',
            replicas: 3,
            cpu_limit: '1000m',
            memory_limit: '2Gi',
            autoscaling: null,
          },
        ],
      },
      null,
      2
    ),
  },
  {
    id: 'ndjson-logs',
    title: 'NDJSON 多行结构化日志流',
    subtitle: '点击「智能修复」可将多行日志自动合并为标准 JSON 数组并转为表格',
    content: `{"ts":1763276401,"level":"INFO","service":"auth","msg":"User login succeeded","uid":1024,"cost_ms":18}
{"ts":1763276405,"level":"WARN","service":"payment","msg":"Gateway timeout, retrying #1","uid":2048,"cost_ms":1204}
{"ts":1763276409,"level":"ERROR","service":"payment","msg":"Insufficient balance","uid":2048,"cost_ms":45}
{"ts":1763276412,"level":"INFO","service":"notify","msg":"Webhook delivered","uid":1024,"cost_ms":63}`,
  },
];

export const DIFF_DEMO_RIGHT = JSON.stringify(
  {
    ...DEFAULT_JSON_OBJ,
    service: {
      ...DEFAULT_JSON_OBJ.service,
      version: 'v2.15.0-rc1',
      region: 'ap-beijing-1',
      canary_weight: 25,
    },
    pagination: {
      page: 1,
      page_size: 50,
      total_items: 4,
    },
    orders: [
      DEFAULT_JSON_OBJ.orders[0],
      {
        ...DEFAULT_JSON_OBJ.orders[1],
        amount: 1999.0,
      },
      {
        ...DEFAULT_JSON_OBJ.orders[2],
        paid: true,
        tags: ['paid', 'coupon'],
      },
      DEFAULT_JSON_OBJ.orders[3],
    ],
  },
  null,
  2
);
