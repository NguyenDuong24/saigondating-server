# GitHub Actions Workflows

## 🔔 Keep Server Awake

Workflow tự động ping server Render mỗi 10 phút để tránh bị sleep (free tier).

### Cấu hình

1. **Thêm GitHub Secret:**
   - Vào repository GitHub: **Settings** → **Secrets and variables** → **Actions**
   - Click **"New repository secret"**
   - Name: `RENDER_SERVICE_URL`
   - Value: URL server Render của bạn (ví dụ: `https://saigon-match-api.onrender.com`)
   - Click **"Add secret"**

2. **Kích hoạt GitHub Actions:**
   - Vào tab **Actions** trên GitHub repository
   - Nếu Actions chưa enabled, click **"I understand my workflows, go ahead and enable them"**
   - Workflow sẽ tự động chạy theo lịch mỗi 10 phút

3. **Test ngay:**
   - Vào tab **Actions**
   - Click workflow **"Keep Render Server Awake"**
   - Click **"Run workflow"** → **"Run workflow"** (chạy thủ công)
   - Xem log để kiểm tra kết quả

### Lịch chạy

- **Tần suất:** Mỗi 10 phút
- **Cron expression:** `*/10 * * * *`
- **Render free tier sleep:** Sau 15 phút không hoạt động
- **Kết luận:** Server sẽ không bao giờ sleep ✅

### Lưu ý

- GitHub Actions free tier: 2,000 phút/tháng cho private repos, unlimited cho public repos
- Workflow này chỉ tốn ~1 giây mỗi lần chạy
- Tổng thời gian/tháng: ~4,320 giây = ~72 phút (rất ít!)

### Endpoint được ping

```
GET https://your-render-url.onrender.com/health
```

Response mong đợi:
```json
{
  "status": "ok",
  "service": "saigon-match-api",
  "timestamp": "2026-07-22T16:50:25.144Z"
}
```

### Vô hiệu hóa workflow

Nếu muốn tắt tạm thời:
1. Vào tab **Actions**
2. Click workflow **"Keep Render Server Awake"**
3. Click menu **"..."** → **"Disable workflow"**
