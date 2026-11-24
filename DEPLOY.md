# Hướng dẫn đưa web lên mạng miễn phí (không cần chạy ngầm trên máy)

Kiến trúc triển khai tách làm 2 phần miễn phí 0 đồng, không cần thẻ ngân hàng:
- **Backend (`backend/`)** chạy Docker trên **Render.com Free** (`512 MB RAM`): dùng `RapidOCR` + `VietOCR ONNX` thuần (không cài PyTorch) + giọng Google `gTTS` + tự dịch Gemini khi gặp truyện ngoại ngữ.
- **Frontend (`frontend/`)** build tĩnh tự động qua GitHub Actions và phát trên **GitHub Pages** tại `https://tronglh06.github.io/TruyenAudio/`.

---

## Phần 1: Đưa Backend lên Render.com Free

1. Đăng nhập hoặc đăng ký tài khoản **Render** (`https://render.com`) bằng tài khoản GitHub `TrongLH06`.
2. Trên Dashboard Render, chọn **New -> Blueprint** (hoặc **New -> Web Service**), kết nối tới repository `TrongLH06/TruyenAudio` (nhánh `main`).
   - Nếu chọn **Blueprint**: Render tự đọc file `render.yaml` và `Dockerfile` đã cấu hình sẵn `plan: free`, `OCR_NUM_THREADS=1`, `OCR_CONCURRENCY=1`, `CORS_ORIGINS=https://tronglh06.github.io`, `JWT_SECRET` và `API_KEY_ENCRYPTION_KEY`.
   - Nếu chọn **Web Service** thủ công: chọn Runtime **Docker**, Instance Type **Free ($0/month)**, giữ nguyên **Dockerfile Path** `./Dockerfile`, và điền các Environment Variables:
     - `APP_ENV` = `production`
     - `CORS_ORIGINS` = `https://tronglh06.github.io` (không thêm `/TruyenAudio` và không có dấu `/` ở cuối)
     - `OCR_NUM_THREADS` = `1`
     - `OCR_CONCURRENCY` = `1`
     - `MALLOC_ARENA_MAX` = `2`
     - `JWT_SECRET` = chuỗi ngẫu nhiên ít nhất 32 ký tự
     - `API_KEY_ENCRYPTION_KEY` = chuỗi ngẫu nhiên khác ít nhất 32 ký tự (khác `JWT_SECRET`)
     - `GEMINI_API_KEY` = key Google AI Studio của bạn (tùy chọn, dùng khi dịch ngoại ngữ hoặc chế độ Kể chuyện AI)
3. Bấm **Apply** / **Create Web Service** và chờ Render build Docker xong (thường mất 2–4 phút cho lần đầu).
4. Sau khi trạng thái chuyển **Live**, sao chép địa chỉ service ở góc trên (dạng `https://luoi-truyen-api.onrender.com`) rồi mở thử `/api/health`:
   `https://luoi-truyen-api.onrender.com/api/health`
   Thấy `"status": "ok"` và `"default_engine": "ocr"` là backend đã sẵn sàng.

---

## Phần 2: Bật Frontend trên GitHub Pages

1. Mở `https://github.com/TrongLH06/TruyenAudio/settings/pages`, tại mục **Build and deployment -> Source** chọn **GitHub Actions**.
2. Mở `https://github.com/TrongLH06/TruyenAudio/settings/variables/actions`, bấm **New repository variable**:
   - **Name**: `VITE_API_BASE_URL`
   - **Value**: dán URL Render vừa tạo ở Phần 1 (ví dụ `https://luoi-truyen-api.onrender.com`, không có dấu `/` ở cuối).
3. Vào tab **Actions** trên GitHub -> chọn workflow `Deploy Frontend to GitHub Pages` -> bấm **Run workflow** (hoặc đẩy commit mới lên `main`).
4. Khi workflow chạy xong màu xanh, mở web trên điện thoại tại:
   `https://tronglh06.github.io/TruyenAudio/`

---

## Lưu ý khi vận hành Render Free

- **Tự ngủ sau 15 phút không có truy cập**: Gói miễn phí của Render cho container ngủ khi không có người dùng sau 15 phút; lần mở lại đầu tiên mất khoảng 40–50 giây để backend khởi động lại rồi hoạt động bình thường.
- **Dữ liệu và cache trên đĩa**: Khi Render ngủ/deploy lại, database SQLite và cache MP3 tạm trên server sẽ tạo mới lại (model `VietOCR ONNX` đã đóng gói sẵn trong repo/Docker nên không phải tải lại). Lịch sử đọc và cài đặt trên điện thoại vẫn được giữ nguyên trong `localStorage` của trình duyệt.
- **Chạy local vẫn giữ nguyên**: Ở máy cá nhân, không đặt `VITE_API_BASE_URL`, frontend tiếp tục gọi `/api` qua Vite proxy tới `http://127.0.0.1:8000`.
