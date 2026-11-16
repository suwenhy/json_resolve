# JSONLens — 现代在线 JSON 解析与可视化工作台

融合 **JSON Crack**（节点图谱可视化）、**JSON Hero**（智能属性透视器）与 **Linear / Geist**（极简工程美学）重新设计的自托管 JSON 在线工具。

- **零外部 CDN 依赖**：无 Google Fonts / unpkg 等外链阻塞，国内云服务器、内网离线环境均可毫秒级首屏加载。
- **100% 浏览器本地计算**：所有解析、修复、比对均在浏览器端完成，敏感业务日志与 Token 绝不上传任何后端。
- **免构建直出部署**：采用原生标准 ES Modules 架构，无需在服务器上安装 Node.js 编译，直接丢进 Nginx / Docker 即可运行。

---

## 核心特性

1. **双栏专业代码编辑器**
   - 实时语法高亮、行号定位、精确到「第 X 行、第 Y 列」的跨浏览器中文错误诊断。
   - 支持编辑器内查找（`⌘/Ctrl + F`）、代码块缩进（`Tab` / `Shift+Tab`）、多文档标签页自动持久化保存与文件拖拽导入。
2. **✨ 一键智能容错修复 (Auto Repair)**
   - 自动剥离 `//` 与 `/* */` 注释、JSONP 函数包裹。
   - 单引号转双引号、未加引号的 JS 对象键名补全、移除多余尾随逗号（Trailing Comma）。
   - 自动转换 Python `True` / `False` / `None`、JS `undefined` / `NaN`、中文全角标点误输，以及将多行 **NDJSON 日志流**合并为数组。
   - 支持一键**递归解包所有内嵌字符串 JSON**、转义 / 去转义、属性键名递归升降序排列。
3. **🌲 树形视图 + 智能属性透视器 (Smart Value Inspector)**
   - 支持关键词搜索过滤及原生 **JSONPath 语法检索**（如 `$.orders[?(@.paid==true)]`、`$..amount`）。
   - 点击任意字段自动识别并解码预览：**JWT Header/Payload 与过期状态**、**Unix 秒/毫秒时间戳本地化**、**ISO 日期**、**HEX/RGB 颜色色块**、**URL 查询参数拆解**、**Base64 UTF-8 文本**与**内嵌 JSON 原地展开**。
4. **🕸️ 可视化节点图谱 (Graph View)**
   - 参照 JSON Crack 设计的交互式 SVG 树状节点图，支持鼠标拖拽平移、滚轮中心缩放、`水平 LR / 垂直 TB` 布局切换、子树折叠以及一键导出 **高清 2x PNG / 矢量 SVG**。
5. **📊 智能数据表格视图 (Table View)**
   - 自动探测深层接口返回体中的所有对象数组（如 `$.orders`），支持列点击排序、行过滤、复制 GitHub Markdown 表格及导出兼容 Excel 中文编码的 **UTF-8 BOM CSV**。
6. **⚡ 多语言类型与格式转换 (CodeGen)**
   - 自动合并数组多元素可选字段，一键生成 **TypeScript Interface**、**Go Struct**、**Python Pydantic**、**Java Lombok**、**Rust Serde**、**JSON Schema**、**YAML** 与 **XML**。
7. **🔀 语义级 JSON 差异对比 (Structural Diff)**
   - 忽略对象键名排版顺序与缩进差异，按 JSONPath 语义路径精准对比 `新增`、`删除`、`修改` 与 `类型变更`，支持直接对比其他已打开的标签页。

---

## 服务器部署指南

### 方式一：一键 Docker 脚本打包部署（强烈推荐）

仓库内置了自动化运维脚本 [`deploy.sh`](./deploy.sh)，支持**端口冲突预检、国内服务器基础镜像自动加速回退、自动拉取最新 Git 代码、平滑替换旧容器与日志轮转限额**。默认监听 **`9680`** 端口（避免与常见的 `8080` 应用冲突）：

```bash
git clone https://github.com/suwenhy/json_resolve.git
cd json_resolve

# 1. 默认使用 9680 端口一键打包并后台启动
./deploy.sh

# 2. 如需自定义端口（例如 18880）
./deploy.sh -p 18880

# 3. 如配合宿主机 Nginx / 宝塔反代，可仅监听本机回环地址
./deploy.sh -b 127.0.0.1 -p 9680
```

日常运维管理命令：
```bash
./deploy.sh status      # 查看运行状态与端口映射
./deploy.sh logs        # 查看实时访问日志
./deploy.sh             # 拉取最新 GitHub 代码并重新打包更新
./deploy.sh uninstall   # 停止并卸载容器与镜像
```

---

### 方式二：Docker Compose 部署

```bash
# 默认映射 9680 端口；也可通过 PORT=18880 docker compose up -d --build 指定端口
docker compose up -d --build
```

启动后访问 `http://您的服务器IP:9680` 即可使用。如需绑定域名与 HTTPS，用宿主机 Nginx / Caddy 反向代理 `127.0.0.1:9680` 即可。

---

### 方式三：Nginx / 宝塔面板直接静态托管（免容器）

本项目采用纯静态相对路径设计，**既支持独立域名根目录，也支持二级子路径（如 `https://yourdomain.com/json/`）**，无需任何编译步骤：

1. 将项目文件上传至服务器目录，例如 `/var/www/jsonlens`：
   ```bash
   scp -r index.html favicon.svg css js root@your-server:/var/www/jsonlens/
   ```
2. **独立域名部署**参考 `deploy/nginx.conf`：
   ```nginx
   server {
       listen 80;
       server_name json.yourdomain.com;
       root /var/www/jsonlens;
       index index.html;
       charset utf-8;
       gzip on;
       gzip_types text/plain text/css application/javascript application/json image/svg+xml;
   }
   ```
3. **挂载到现有网站二级目录（如 `/json/`）**：
   ```nginx
   location /json/ {
       alias /var/www/jsonlens/;
       index index.html;
   }
   ```
4. 重载配置：`nginx -t && nginx -s reload`

---

### 方式四：Caddy 自动签发 HTTPS

参考 `deploy/Caddyfile`，修改域名后执行 `caddy reload` 即可自动完成 Let's Encrypt SSL 证书申请与 HTTP/3 加速。

---

## 本地开发与验证

```bash
# 本地启动静态预览服务
python3 -m http.server 8080

# 运行核心解析、修复、JSONPath、代码生成与 Diff 单元测试
node --test tests/core.test.mjs
```
