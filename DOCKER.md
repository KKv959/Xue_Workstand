# Docker 运行

镜像包含完整应用和 FFmpeg。素材库、密钥和浏览器登录状态不进入镜像，现有数据通过目录挂载保留。构建在容器内进行，不影响本机开发服务的 `.next`。

需要 Docker Engine 和 Docker Compose 2.24 或更新版本。

```sh
cp .env.example .env.docker
# 编辑 .env.docker，填写模型等配置。
docker compose up -d --build
```

访问 http://localhost:3000。若本机开发服务占用 3000，使用 `WORKBENCH_PORT=3002 docker compose up -d --build` 后访问 3002。

默认挂载现有 `./style-library`。自定义素材库使用 `DOCKER_LIBRARY_DIR=/绝对路径 docker compose up -d`；目录必须已存在，并允许容器中的 UID 1000 读写。首次使用空素材库时先创建专用目录。容器会直接写入所挂载的素材库，正式使用前建议备份，不要让多个应用实例同时修改同一素材库。

`.env.docker` 中的 `STYLE_LIBRARY_DIR` 会被 Compose 固定的容器路径覆盖；主机目录由 `DOCKER_LIBRARY_DIR` 控制。容器访问宿主机代理时，将 `CHAT_PROXY_URL`、`WEB_RESEARCH_PROXY_URL` 等中的 `127.0.0.1` 改为 `host.docker.internal`，并确保代理允许连接；不用代理则清空这些配置。`NEXT_PUBLIC_*` 为构建时变量，运行时 env 文件不能改变已编译的前端值。

## 外部能力

OpenCLI 依赖已登录的 Chrome；Lark CLI 和官方 WeCom CLI 依赖各自授权。镜像不包含这些 CLI 或宿主机的凭据。这版镜像可运行工作台，但相关采集和云文档操作还需要在扩展镜像中安装对应 Linux CLI、完成授权，并连接浏览器服务；不能直接复用 macOS 的可执行文件。模型 API、素材库和 FFmpeg 使用容器自身配置。

## 管理与导出

```sh
docker compose logs -f --tail=100
docker compose down
docker image save content-workbench:local -o content-workbench.tar
# 目标机器加载后，携带 compose.yaml 和自行配置的 .env.docker，单独准备素材库
docker image load -i content-workbench.tar
docker compose up -d --no-build
```

`down` 不删除挂载目录。镜像只适用于构建时的 CPU 架构；跨架构分发需用 Docker Buildx 为目标平台构建。
