# 🏥 Health Check & Monitoring

## Endpoint Health Check

### URL
```
GET /health
```

### Response
```json
{
  "status": "ok",
  "service": "saigon-match-api",
  "timestamp": "2026-07-22T16:50:25.144Z"
}
```

### Đặc điểm
- ✅ **Không cần authentication**
- ✅ **Không truy vấn database**
- ✅ **Không gọi Firebase**
- ✅ **Không gọi external APIs**
- ✅ **Response time < 10ms**
- ✅ **HTTP 200 OK**

### Sử dụng

#### Local Development
```bash
curl http://localhost:3000/health
```

#### Production (Render)
```bash
curl https://your-render-url.onrender.com/health
```

---

## 🚀 Render Deployment

### Health Check trên Render

1. Vào Render Dashboard → Service của bạn
2. Tab **Settings** → **Health & Alerts**
3. Cấu hình:
   - **Health Check Path:** `/health`
   - **Health Check Interval:** 30 seconds (hoặc tùy chọn)

Render sẽ tự động restart service nếu health check fail.

---

## 🔔 Keep Server Awake (Free Tier)

Render free tier tự động sleep sau **15 phút không hoạt động**.

### Giải pháp: GitHub Actions Cron Job

Workflow tự động ping endpoint `/health` mỗi **10 phút**.

#### Setup trong 3 bước:

**1. Push code lên GitHub:**
```bash
git add .
git commit -m "feat: add health check and keep-awake workflow"
git push origin main
```

**2. Thêm GitHub Secret:**
- Vào: **Settings** → **Secrets and variables** → **Actions**
- Thêm secret:
  - Name: `RENDER_SERVICE_URL`
  - Value: `https://your-render-url.onrender.com` (không có `/` cuối)

**3. Kích hoạt Actions:**
- Vào tab **Actions** trên GitHub
- Nếu chưa enabled → click **"Enable Actions"**
- Workflow sẽ tự động chạy mỗi 10 phút

#### Test ngay:
- Tab **Actions** → **Keep Server Awake**
- Click **"Run workflow"** → **"Run workflow"**
- Xem log để kiểm tra

---

## 📊 Monitoring Services

Bạn có thể sử dụng các dịch vụ monitoring miễn phí:

### 1. UptimeRobot (Khuyến nghị)
- Website: https://uptimerobot.com
- Free: 50 monitors, check mỗi 5 phút
- Cấu hình:
  - Monitor Type: HTTP(s)
  - URL: `https://your-render-url.onrender.com/health`
  - Monitoring Interval: 5 minutes
  - Alert Contacts: Email/Telegram/Slack

### 2. Uptime Kuma (Self-hosted)
- GitHub: https://github.com/louislam/uptime-kuma
- Free, open-source
- Có thể host trên Render/Railway miễn phí

### 3. Better Uptime
- Website: https://betteruptime.com
- Free: 10 monitors, check mỗi 3 phút

### 4. Pingdom
- Website: https://pingdom.com
- Free trial: 30 days

---

## 🧪 Testing

### Test Local
```bash
# Khởi động server
npm start

# Test endpoint (terminal khác)
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "saigon-match-api",
  "timestamp": "2026-07-22T16:50:25.144Z"
}
```

### Test Production
```bash
curl https://your-render-url.onrender.com/health
```

### Test với PowerShell (Windows)
```powershell
Invoke-RestMethod -Uri http://localhost:3000/health -Method Get
```

---

## 📈 Logs

### Xem logs trên Render:
1. Render Dashboard → Service
2. Tab **Logs**
3. Tìm kiếm: `GET /health`

### Xem logs GitHub Actions:
1. GitHub repository → Tab **Actions**
2. Click workflow run
3. Xem chi tiết execution

---

## 🔧 Troubleshooting

### Health check trả về 404
- Kiểm tra URL có đúng `/health` không (không có `/api/health`)
- Kiểm tra server đã deploy phiên bản mới chưa

### Health check timeout
- Server có thể đang wake up từ sleep mode
- Đợi 30-60 giây và thử lại
- Kiểm tra logs trên Render

### GitHub Actions fail
- Kiểm tra secret `RENDER_SERVICE_URL` đã được thêm chưa
- Kiểm tra URL không có `/` ở cuối
- Kiểm tra Actions đã được enabled chưa

---

## 📝 Notes

- Endpoint `/health` được thiết kế để phản hồi nhanh nhất có thể
- Không làm ảnh hưởng đến business logic của ứng dụng
- Có thể được gọi unlimited lần mà không lo rate limiting
- Phù hợp cho các công cụ monitoring và load balancers
