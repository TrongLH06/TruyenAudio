# Lười Truyện (TruyenAudio) — Web Đọc Truyện Tranh Tự Lướt & Thuyết Minh AI

Ứng dụng web đọc truyện tranh tối ưu cho trải nghiệm rảnh tay: tự động cuộn mượt khớp thời lượng giọng đọc Google miễn phí (`gTTS`), AI Gemini đọc ảnh tạo kịch bản theo 2 chế độ (**Thuyết minh kể chuyện** và **Đọc sát thoại**), tự dịch truyện Anh/Nhật/Hàn sang tiếng Việt, kèm phụ đề và hẹn giờ tắt.

## Tính năng chính
- **Đa nguồn truyện**:
  - **HiNetTruyen**: Kho truyện tiếng Việt đầy đủ (Truyện Đề Cử, 36 truyện mới cập nhật có phân trang, Bảng Xếp Hạng Top Tháng/Tuần/Ngày, lọc Thể Loại, tìm kiếm, tải đủ toàn bộ danh sách chương kèm chia khoảng 100 chương).
  - **MangaDex**: Kho truyện quốc tế hỗ trợ AI Gemini tự dịch Anh/Nhật/Hàn sang lời thuyết minh tiếng Việt.
  - **Kho Máy (Upload)**: Tải lên trực tiếp nhiều ảnh (`JPG`/`PNG`/`WEBP`) hoặc file `ZIP`, `CBZ`, `PDF`.
- **2 chế độ thuyết minh + cache dùng chung**: Chuyển nhanh giữa *Thuyết minh kể chuyện* và *Đọc sát thoại*; xử lý cuốn chiếu 3 trang kế tiếp trong nền và lưu cache dùng chung toàn hệ thống.
- **Trải nghiệm Reader mượt mà**:
  - Tự cuộn mượt đồng bộ 60fps với tiến độ âm thanh, thanh tiến độ trực quan và nút **Tạm dừng / Tiếp tục** đúng vị trí giữa trang.
  - Tự nhận diện trang đang xem khi cuộn tay (`IntersectionObserver`), tự tạm dừng khi chạm/vuốt màn hình, chạm vào tranh để ẩn/hiện thanh công cụ trên.
  - Chỉnh tốc độ 0.75x–2x, phụ đề cạnh dưới, hẹn giờ tắt (15 / 30 / 60 phút), phím tắt (`Space`, `◄/►`, `A/D`), chế độ Rạp phim (tắt đèn) và đổi độ rộng khung ảnh (`740px` / `880px` / `Full`).
- **Tài khoản, BYOK & Lịch sử khách**: Đăng ký/đăng nhập JWT, lưu tủ truyện yêu thích, tự nhớ chương/trang đang đọc (hoạt động cả khi chưa đăng nhập qua `localStorage` và đồng bộ tài khoản khi đăng nhập), hỗ trợ nhập Gemini API key cá nhân (mã hóa Fernet trên máy chủ).

## Cài đặt và chạy local

### 1. Backend (Python FastAPI)
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip.exe install -r requirements.txt
copy .env.example .env
# (Tùy chọn) Điền GEMINI_API_KEY và đổi JWT_SECRET, API_KEY_ENCRYPTION_KEY trong file .env
.\.venv\Scripts\uvicorn.exe app.main:app --reload --port 8000
```

### 2. Frontend (React + Vite + Tailwind CSS)
```powershell
cd frontend
npm install
npm run dev
```

Mở trình duyệt tại `http://localhost:5173`.

## Đóng gói & Đưa lên mạng miễn phí (không cần bật máy)
- Xem hướng dẫn chi tiết từng bước tại [DEPLOY.md](DEPLOY.md) (Frontend trên **GitHub Pages**, Backend OCR ONNX thuần + Giọng Google chạy Docker miễn phí 512 MB RAM trên **Render.com**, không cần PyTorch).

```bash
docker build -t truyen-audio .
docker run -p 10000:10000 \
  -e APP_ENV=production \
  -e JWT_SECRET="your-32-char-random-jwt-secret-here" \
  -e API_KEY_ENCRYPTION_KEY="your-separate-32-char-encryption-key" \
  -e CORS_ORIGINS="https://your-github-username.github.io" \
  -e GEMINI_API_KEY="your-gemini-api-key" \
  truyen-audio
```
