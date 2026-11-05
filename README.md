> [!IMPORTANT]
> 本仓库已拆分为两个独立仓库：图片 [dsh-image-studio](https://github.com/Brian-dai694/dsh-image-studio) · 视频 [dsh-video-studio](https://github.com/Brian-dai694/dsh-video-studio)。
> 此处保留为一体化原型的历史快照，后续开发以两个独立仓库为准。
# DSH Media Studio 鈥?鍥剧墖 / 瑙嗛浜烘満鍗忎綔缂栬緫鍣?
DeepSeek Harness 鎻掍欢鍘熷瀷锛氬乏渚у師鐢熺紪杈戝櫒锛堝浘鐗囩敤 miniPaint锛岃棰戠敤鍘熺敓 video/Canvas锛夛紝
鍙充晶鏄?*鐪熷疄 DSH 浼氳瘽**锛坄ctx.remote.session.prompt/follow`锛夛紝浜哄拰 Agent 鍏变韩鍚屼竴浠藉師鐢熷伐绋嬬姸鎬併€?
## 鐩綍

| 鐩綍 | 鍐呭 |
| --- | --- |
| `plugin/dsh-media-studio` | DSH 鎻掍欢锛欻ost 宸ュ叿锛坱ools/bridge/gate/relay锛夈€乧lient 鍙屽叆鍙ｃ€乮frame transport |
| `miniPaint/miniPaint-master` | 涓枃 miniPaint 搴曞骇锛圓pple 涓婚銆佸師鐢熷巻鍙叉ˉ銆丳NG/JPEG 瀵煎嚭锛?|
| `video` | 瑙嗛缂栬緫鍣?MVP锛堝崟杞ㄥ壀杈戙€佹枃瀛?鍥剧墖鍙犲姞銆佹挙閿€閲嶅仛銆乄ebM 鍚堟垚瀵煎嚭锛?|
| `host` | 瀹夸富椤典笌 iframe transport |
| `contracts` | `editor-bridge.v1` 濂戠害銆佷細璇?瀹℃壒鎺ュ彛鏍告煡璁板綍 |

## 鍗忎綔妯″瀷

- 鐘舵€佺敱缂栬緫鍣ㄥ敮涓€鎸佹湁锛汬ost 鍙仛鐧藉悕鍗曞懡浠ゃ€乣expectedRevision`銆乣commandId` 闃查噸涓庡璁°€?- 鍐欏叆鍚庣珛鍗冲洖璇绘牎楠岋紱缁撴灉鏈煡璁颁负 `unknown` 骞剁姝㈤噸鏀俱€?- 瀹氬悜鎾ら攢闇€ `commandId + afterDigest + revision + 鍘嗗彶鏍堥《` 鍏ㄩ儴鍖归厤锛屽惁鍒?`HISTORY_CONFLICT`銆?- 棣栨缁戝畾锛氱湡瀹炲伐鍏?`exec` 韬唤 + 鍘熺敓瀹℃壒 `allowed-once` + 瀹℃壒鍓嶅悗椤甸潰/宸ョ▼/蹇収涓€鑷达紝Host 鎵嶇櫥璁般€?  瀹㈡埛绔嚜鎶?`sessionId` 涓嶅弬涓庢巿鏉冦€?
## 鏋勫缓涓庢祴璇?
```bash
# 鎻掍欢
cd plugin/dsh-media-studio && pnpm install && node --test test/*.test.mjs

# 瑙嗛缂栬緫鍣紙鐘舵€?/ 妗?/ 椤甸潰 / 鎵撳寘涓€鑷存€э級
cd video && node tests/video-bridge.test.mjs && node tests/video-state.test.mjs \
  && node tests/video-page.test.mjs && node tests/video-package.test.mjs

# miniPaint 鍥剧墖椤?cd miniPaint/miniPaint-master && npm install && npm run build
```

鎵撳寘浜х墿锛坄plugin/dist/*.tgz`锛変笌 `node_modules` 涓嶅叆搴撱€?
## 瑙嗛瀵煎嚭鏍煎紡

瀵煎嚭璧板崟 Canvas 鍚堟垚 + `MediaRecorder`锛氭妸婧愮敾闈紙鎸夎鍒囧尯闂达級銆佸浜?`[start, end)` 鐨勬枃瀛?鍥剧墖鍙犲姞锛?浠ュ強婧愰煶杞ㄥ悎鎴愪竴鏉℃祦锛屽綍鍒朵负 **WebM**锛涙棤闊宠建绱犳潗浼氬瀹炴爣娉ㄣ€岀礌鏉愭棤闊宠建銆嶃€?
**MP4 鏈獙璇侊紝鏆備笉鍙敤**锛氶〉闈㈡樉绀恒€孧P4 鏈獙璇併€嶏紝瀵煎嚭宸ュ叿鏀跺埌 `format=mp4` 浼氳繑鍥?`EXPORT_FORMAT_UNAVAILABLE`锛屼笉浼氶潤榛橀檷绾ф垨璋庢姤鎴愬姛銆?
## 宸茬煡闄愬埗

- 瑙嗛瀵煎嚭锛堥煶鐢诲悎鎴愩€佺湡瀹炴挱鏀炬牎楠岋級銆佸伐绋嬮噸寮€涓庡獟浣撻噸杩炰粛闇€鐪熷疄濯掍綋楠屾敹锛涘綋鍓嶅彧鏈夐潤鎬佷笌妗ョ骇娴嬭瘯璇佹嵁銆?- 濯掍綋涓嶅祵鍏ュ伐绋嬪揩鐓э紝閲嶅紑宸ョ▼闇€閲嶆柊閫夋嫨鍚屼竴婧愯棰戯紙鎸?`sourceRef` 鑷姩閲嶈繛锛屼笉鏂板缓鐗囨锛夈€?- 瀹℃壒绛夊緟鍙楀涓诲伐鍏疯秴鏃剁害鏉燂紝淇鍚庨渶閲嶆柊鍙戣捣涓€娆℃巿鏉冦€?- 閮ㄥ垎鑳藉姏锛堟瀬绠€甯冨眬銆佺粨鏋滃崱鎾ら攢鎸夐挳锛夐粯璁ゅ叧闂紝寰呴獙鏀跺悗寮€鏀俱€?
