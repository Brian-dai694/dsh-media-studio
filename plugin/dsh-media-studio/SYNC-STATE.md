# 磁盘同步固化清单（diagram-test 安装副本）

- 生成时间：2026-11-03 16:16:57 +08:00
- 源目录：`C:\Users\UEFR\.dsh\bot\workspace\diagram-studio-prototype\plugin\dsh-media-studio`
- 安装副本：`C:\Users\UEFR\.dsh\profiles\diagram-test\node_modules\dsh-media-studio`
- 运行实例：PID 13256（存活，StartTime 11/03/2026 16:08:45），`/media/boot` => 200
- lib 差异数：0
- public/image 文件数：源 42 / 安装 42，差异数：0

| 文件 | 源 SHA-256 | 安装 SHA-256 | 结果 |
|---|---|---|---|
| lib/bounded-output.js | 402112B1B9E3… | 402112B1B9E3… | same |
| lib/bridge.js | E28B35851748… | E28B35851748… | same |
| lib/gate.js | F797BF888E8D… | F797BF888E8D… | same |
| lib/http.js | 6B40741B6E16… | 6B40741B6E16… | same |
| lib/index.js | 1F0EB27FE22E… | 1F0EB27FE22E… | same |
| lib/relay.js | 597C468295F7… | 597C468295F7… | same |
| lib/tools.js | 68F2D1846D3A… | 68F2D1846D3A… | same |

说明：本轮只做覆盖拷贝，未执行 remove/adٰd，未重启实例；运行中的进程仍持有旧 `index.js`，图片页需重启后生效。
