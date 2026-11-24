# Hướng dẫn đưa web lên mạng miễn phí (không cần chạy ngầm trên máy)

Kiến trúc triển khai tách làm 2 phần miễn phí 0 đồng:
- **Backend (`backend/`)** chạy trên **Hugging Face Spaces** (gói Docker miễn phí `CPU basic • 16 GB RAM • 2 vCPU`, chạy được RapidOCR + VietOCR + giọng Google `gTTS` + Gemini).
- **Frontend (`frontend/`)** build tĩnh tự động qua GitHub Actions và phát trên **GitHub Pages** (tải nhanh trên điện thoại, dùng HashRouter để không lỗi 404 khi tải lại trang).

---

## Phần 1: Đưa Backend lên Hugging Face Spaces

1. Đăng nhập Hugging Face (`https://huggingface.co`), chọn **Create new -> Space**.
   - **Space name**: ví dụ `luoi-truyen-api`
   - **Select the Space SDK**: chọn **Docker -> Blank**
   - **Space hardware**: giữ mặc định **CPU basic · 2 vCPU · 16 GB RAM (Free)**
   - Chế độ hiển thị: nên để **Public** để frontend trên điện thoại gọi API và phát file MP3 không bị chặn token.

2. Tạo sẵn 2 chuỗi bí mật ngẫu nhiên (ít nhất 32 ký tự, khác nhau) bằng PowerShell trên máy:
   ```powershell
   -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
   ```
   Chạy lệnh trên 2 lần để lấy 2 chuỗi khác nhau cho `JWT_SECRET` và `API_KEY_ENCRYPTION_KEY`.

3. Vào **Settings** của Space vừa tạo, mục **Variables and secrets**, thêm:
   - **Secrets** (bắt buộc / bảo mật):
     - `APP_ENV` = `production`
     - `JWT_SECRET` = `<chuỗi-48-ký-tự-thứ-1>`
     - `API_KEY_ENCRYPTION_KEY` = `<chuỗi-48-ký-tự-thứ-2>`
     - `GEMINI_API_KEY` = `<key-google-ai-studio>` (tùy chọn, dùng khi đọc chế độ AI hoặc tự dịch truyện ngoại ngữ)
   - **Variables** (bắt buộc đúng origin GitHub Pages, **không có dấu `/` ở cuối và không kèm tên repo**):
     - `CORS_ORIGINS` = `https://<ten-github-cua-ban>.github.io`
     - Nếu muốn hỗ trợ thêm cả local khi test: `https://<ten-github-cua-ban>.github.io,http://localhost:5173,http://127.0.0.1:5173`

4. Đẩy mã nguồn từ thư mục `d:\Agent\lazy-comic-reader` lên Space (file `backend/.env`, `backend/storage/`, `node_modules/` đã được `.gitignore` và `.dockerignore` loại trừ tự động):
   ```powershell
   cd d:\Agent\lazy-comic-reader
   git init -b main
   git add .
   git commit -m "Setup Luoi Truyen for HF Spaces and GitHub Pages"
   git remote add hf https://huggingface.co/spaces/<ten-hf-cua-ban>/luoi-truyen-api
   git push -u hf main
   ```
   Khi Hugging Face hỏi mật khẩu Git, nhập **Access Token (Write)** lấy tại `https://huggingface.co/settings/tokens`.

5. Chờ Space build xong (khoảng 3–5 phút cho lần đầu tải CPU PyTorch và đóng gói sẵn model OCR). Mở thử địa chỉ:
   `https://<ten-hf-cua-ban>-luoi-truyen-api.hf.space/api/health`
   Nếu thấy `"status": "ok"` và `"default_engine": "ocr"` là backend đã hoạt động.

---

## Phần 2: Đưa Frontend lên GitHub Pages

1. Tạo một repository mới trên GitHub (ví dụ `luoi-truyen`).

2. Vào **Settings -> Pages** trong repository GitHub:
   - Mục **Build and deployment -> Source**: chọn **GitHub Actions**.

3. Vào **Settings -> Secrets and variables -> Actions -> tab Variables**, bấm **New repository variable**:
   - **Name**: `VITE_API_BASE_URL`
   - **Value**: `https://<ten-hf-cua-ban>-luoi-truyen-api.hf.space` (không có dấu `/` ở cuối)

4. Đẩy code lên GitHub:
   ```powershell
   cd d:\Agent\lazy-comic-reader
   git remote add origin https://github.com/<ten-github-cua-ban>/luoi-truyen.git
   git push -u origin main
   ```

5. Vào tab **Actions** trên GitHub chờ workflow `Deploy Frontend to GitHub Pages` chạy xong (`frontend/dist` sẽ tự build và phát hành). Mở web trên điện thoại tại:
   `https://<ten-github-cua-ban>.github.io/luoi-truyen/`

---

## Lưu ý khi vận hành miễn phí

- **Tự ngủ sau 48 giờ không có truy cập**: Gói miễn phí của Hugging Face Spaces sẽ tạm ngủ nếu 48 tiếng không có request; lần đầu mở lại mất khoảng 20–40 giây để khởi động container rồi sau đó chạy bình thường.
- **Dữ liệu và cache trên đĩa**: Khi Space rebuild hoặc khởi động lại sau khi ngủ, dữ liệu SQLite (`storage/app.db`) và cache MP3 tạm trên Space sẽ tạo mới lại (các model VietOCR/RapidOCR đã được đóng gói sẵn trong Docker image nên không phải tải lại). Lịch sử đọc truyện và cài đặt trên điện thoại vẫn được giữ nguyên trong `localStorage` của trình duyệt.
- **Chạy local vẫn giữ nguyên**: Ở máy cá nhân, không đặt `VITE_API_BASE_URL`, frontend tiếp tục gọi trực tiếp `/api` qua Vite proxy tới `http://127.0.0.1:8000`.
