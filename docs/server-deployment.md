# 服务器部署

本项目通过 `liujian811/ziwei-doushu` 的 `codex/server-deployment` 分支发布。推送该分支或在该分支手动运行 `Deploy to server` 会依次安装锁定依赖、执行类型检查与排盘回归、构建 Next.js standalone、保留发布包并通过 SSH 上传服务器。

## 应用边界

开源排盘、命盘展示、合盘起盘和古籍阅读可直接运行，不需要数据库、Redis 或 AI Key。上游没有提供 `/api/interpret`、`/api/heming`、用户系统、支付和完整断语库；配置模型 Key 不会自动补齐接口。大型解读数据集为独立资源，正常安装不需要下载。

## 一次性服务器准备

需要 Linux、systemd、Node.js 22、Python 3.9+、curl、util-linux（flock）、sudo、OpenSSH。下列操作由管理员在评估现有服务后执行。不要覆盖服务器上同名已有应用；先检查端口 `3080` 未占用。

1. 创建专用 `ziwei` 用户及组；SSH 登录 shell 使用 `/bin/bash`，不设置可用于登录的密码。创建 `/opt/ziwei-doushu/releases` 和 `/opt/ziwei-doushu/tmp`，整个应用目录由 `ziwei:ziwei` 持有，权限 `0750`。首次部署前不要创建 `current`。
2. 将 `deploy/receive-release.sh` 安装为 `/usr/local/libexec/ziwei-receive-release`，属主 `root:root`，权限 `0755`。专用用户不得修改该文件或父目录。
3. 将 `deploy/ziwei-doushu.service` 安装到 `/etc/systemd/system/ziwei-doushu.service`。确认服务器 Node 22 位于 `/usr/local/bin/node`；若实际路径不同，修改 `ExecStart` 为已验证的绝对路径。执行 `systemd-analyze verify`、`systemctl daemon-reload`、`systemctl enable ziwei-doushu.service`。没有 `current/server.js` 时服务会因条件不满足而跳过启动。
4. 用 `visudo -cf deploy/ziwei-doushu.sudoers` 检查规则，再安装为 `/etc/sudoers.d/ziwei-doushu`，属主 `root:root`，权限 `0440`。规则只允许 `ziwei` 重启或停止这一个服务，不允许任意 sudo 命令。
5. 单独生成发布用 SSH key。将公钥加入专用用户的 `authorized_keys`，每行格式如下（不要使用管理员私钥作为发布密钥）：

   ```text
   restrict,command="/usr/local/libexec/ziwei-receive-release" ssh-ed25519 PUBLIC_KEY ziwei-github-actions
   ```

   当前部署将账号 home 设为 `/var/lib/ziwei`，该目录和 `.ssh` 均为 root:root、0755，`authorized_keys` 为 root:root、0644；应用用户不可修改授权文件或替换其父目录，无需改动全局 SSH 配置。`restrict` 禁止端口转发、agent 转发、X11 和 PTY，forced command 只接受 `deploy <40位小写SHA>`，不提供交互 shell。

6. 获取并从可信服务器管理通道核对 SSH 主机公钥，将完整 known_hosts 行保存到 GitHub secret。不要在工作流中临时使用未经核验的 `ssh-keyscan`，不要关闭主机密钥校验。
7. 服务仅监听 `127.0.0.1:3080`。管理员单独为选定域名配置 Nginx、DNS 和 HTTPS；此工作流不会修改这些设置，也不需要开放公网 `3080`。

首次失败时接收脚本移除 `current` 并停止此专用服务；已有版本时自动恢复原 `current` 并重启。两条 sudo 授权均限定完整命令和单一服务名。

## GitHub 配置

在 fork 的 Actions 设置中启用工作流，并配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | `SITE_URL` | 实际公网 origin，例如 `https://ziwei.example.com`；不可含子路径。缺失会阻止构建 |
| Secret | `SSH_HOST` | SSH 主机名或 IPv4，使用端口 22 |
| Secret | `SSH_PRIVATE_KEY` | 上述专用部署私钥，完整多行内容 |
| Secret | `SSH_KNOWN_HOSTS` | 经过核验的主机公钥 known_hosts 行 |

SSH 用户固定为 `ziwei`。`NEXT_PUBLIC_SITE_URL` 在构建时写入应用，用于 canonical、sitemap 与站点显示；更改域名后需重新构建。不要把 Key 写入 Git 仓库。

## 发布与验收

每个提交安装到 `/opt/ziwei-doushu/releases/<40位SHA>`；相同 SHA 的目录已存在时拒绝覆盖。工作流保存 14 天的 `release.tar.gz` 和 SHA256 文件。归档不接受越界路径、逃逸软链接、设备文件或写入软链接父目录，提取后检查 standalone 入口和版本标记。

发布前 `previous` 指向原 `current`。切换通过原子替换 `current` 符号链接完成，然后重启服务。健康检查同时要求首页 HTTP 成功及 `/deployment-revision.txt` 等于目标 SHA，避免将旧版本响应误认为发布成功。失败自动切回原版本并再次检查。失败版本目录保留供排错，不自动清理其他版本。

管理员确认 `systemctl status ziwei-doushu`、`journalctl -u ziwei-doushu -n 100 --no-pager`，并核对公网首页、`/chart`、`/library`、`/heming`、sitemap。浏览器实际生成一张命盘、打开宫位、切换本命/大限/流年、测试古籍搜索，并确认缺失的 AI 接口给出开源版提示。HTTP 健康检查不替代这些功能验收。

## 恢复与排错

自动恢复失败时，先检查日志、磁盘、Node 版本及 `/opt/ziwei-doushu/current` 和 `previous` 的指向。不要删除现有 release 或直接覆盖文件。管理员可选择已验证的旧 SHA 手动恢复：

```bash
# 用真实的、已经存在并验证过的 40 位 SHA 替换占位值。
release_sha=REPLACE_WITH_VERIFIED_40_CHARACTER_SHA
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || exit 1
test -f "/opt/ziwei-doushu/releases/$release_sha/server.js" || exit 1
ln -s "/opt/ziwei-doushu/releases/$release_sha" /opt/ziwei-doushu/.manual-current
mv -Tf /opt/ziwei-doushu/.manual-current /opt/ziwei-doushu/current
systemctl restart ziwei-doushu.service
curl --fail http://127.0.0.1:3080/deployment-revision.txt
curl --fail --output /dev/null http://127.0.0.1:3080/
```

比较返回的版本标记与选定 SHA，并再做公网检查。`previous` 保留上一发布指针；手动回滚前记录当前与 previous，避免丢失恢复依据。如首次部署无可用版本，管理员可 `systemctl stop ziwei-doushu.service`，修复后提交新 SHA 再部署。

已成功发布的相同 SHA 不能通过重跑任务覆盖；需要重新构建时创建新提交。某个 SHA 首次发布失败而目录已保留时，先修复原因并创建新提交，或由管理员把失败目录移至独立备份位置后重跑。若本地发布包丢失，可从对应 GitHub Actions run 下载保存期内的 artifact，校验 SHA256，并使用相同的受限 SSH 命令上传；保留期以外从原提交重新构建。服务器上的现有 release 不随 Actions artifact 到期删除。
