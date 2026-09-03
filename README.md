# fudan-xk-automation
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://makeapullrequest.com)
>本项目仅用于研究 **浏览器自动化与并发调度技术** 。  
>作者**绝不支持**利用本工具进行大规模抢课、影响他人正常选课的行为。

## Local Server

The project includes a local scheduling server for receiving client requests and managing course selection tasks.

### Requirements

- Node.js >= 20

### Run

```bash
npm install
npm run start:server
```

The server listens on `http://127.0.0.1:30522` by default.

### API

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/start` | Start the scheduler |
| `POST` | `/stop` | Stop the scheduler |
| `GET` | `/status` | Get the current scheduler status |
| `POST` | `/course/pause` | Pause a specific course |
| `POST` | `/course/resume` | Resume a specific course |

### Captcha

Captcha solving is lookup-based: `(imgIndex, posIndex) → moveEndX`.

Records are fetched from the maintainer's personal server by default:

`https://tempfile.char.moe/course-grabber/FudanCourseGrabber/captchaRecords/`

Each `<imgIndex>.json` maps `posIndex` to `moveEndX`. Set `CAPTCHA_RECORDS_PATH` to use local records instead. **Availability of the default source is not guaranteed.**
