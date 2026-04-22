# BTL HTN Nhom 11

# Hệ thống IoT phát hiện khí gas, lửa và camera cảnh báo

Dự án gồm 3 phần chính:
- `backend`: MQTT broker + REST API + WebSocket + xác thực JWT + OTA + nhận ảnh từ ESP32-CAM
- `frontend`: giao diện dashboard realtime (đăng nhập/đăng ký, điều khiển thiết bị, biểu đồ gas, OTA)
- firmware ESP32:
  - `main_mqtt`: ESP32 đọc cảm biến MQ2/lửa, điều khiển relay/servo/buzzer, nhận lệnh OTA
  - `esp32_cam_mqtt`: ESP32-CAM nhận lệnh chụp, chụp ảnh và upload JPEG về backend

## Thành viên nhóm

| STT | Họ tên | Mã sinh viên | Đóng góp |
| --- | --- | --- | --- |
| 1 | Đỗ Văn An | B22DCCN002 | Module cảm biển khí gas và cảm biến phát hiện lửa |
| 2 | Đỗ Đức Cảnh | B22DCCN086 | Module điều khiển camera tự động chụp ảnh hiện trường có lửa |
| 3 | Trần Quang Huy | B22DCCN397 | Module cập nhật firmware từ xa & thống kê khí gas realtime |
| 4 | Trần Quang Huy | B22DCCN398 | Module giao tiếp thiết bị qua MQTT + WebSocket |
| 5 | Nguyễn Việt Quang | B22DCCN620 | Module điều khiển relay/sửa sổ & xác thực người dùng |

## Tính năng hiện tại

- Giám sát realtime dữ liệu gas/lửa qua MQTT + WebSocket
- Điều khiển relay/cửa sổ, đổi AUTO/MANUAL, cập nhật ngưỡng gas từ web
- Cảnh báo cháy/gas, tự gửi lệnh chụp ảnh camera khi có fire alert
- Upload và rollout firmware OTA cho ESP32 qua web/API
- Đăng nhập/đăng ký người dùng với SQLite + JWT
- Lưu lịch sử ảnh tại `backend/captures`, lưu metadata firmware tại `backend/firmware`

## Cấu trúc thư mục

```text
Source Code/
├── backend/
│   ├── server.js
│   ├── package.json
│   ├── captures/        # Ảnh camera đã lưu
│   └── data/
│       └── users.db     # DB user đăng nhập
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── main_mqtt/
│   ├── main_mqtt.ino
│   ├── config.h
│   ├── def.h
│   └── mybutton.h
└── esp32_cam_mqtt/
    └── esp32_cam_mqtt.ino
```

## Yêu cầu môi trường

- Node.js 18+ (khuyên dùng LTS)
- Arduino IDE / PlatformIO
- ESP32 Dev Module (node chính)
- ESP32-CAM AI Thinker
- WiFi 2.4GHz (ESP32 không hỗ trợ 5GHz)

## Chạy backend + frontend

Từ thư mục `Source Code`:

```bash
cd backend
npm install
npm start
```

Sau khi chạy, backend mở các dịch vụ:
- HTTP: `http://localhost:3000`
- MQTT broker: `mqtt://localhost:1883`
- WebSocket: `ws://localhost:8888`

Frontend được backend serve trực tiếp tại `/`, mở:
- `http://localhost:3000`

## Cấu hình firmware ESP32 (main node)

File chính: `main_mqtt/main_mqtt.ino`

Luồng cấu hình:
- ESP32 có thể chạy AP để nhập WiFi + MQTT broker IP tại `http://192.168.4.1`
- Thông tin được lưu EEPROM
- Sau khi vào STA mode, thiết bị publish:
  - `device/{deviceId}/data`
  - `device/{deviceId}/alert`
  - `device/{deviceId}/ota/status`
- Thiết bị subscribe:
  - `device/{deviceId}/control`
  - `device/{deviceId}/ota`

Thư viện Arduino cần có:
- `PubSubClient`
- `ArduinoJson` (v6)
- `ESP32Servo`
- `SimpleKalmanFilter`
- `LiquidCrystal`
- `HTTPClient`, `Update`, `EEPROM` (core ESP32)

## Cấu hình firmware ESP32-CAM

File chính: `esp32_cam_mqtt/esp32_cam_mqtt.ino`

Các biến cần sửa theo mạng thật:
- `WIFI_SSID`, `WIFI_PASS`
- `MQTT_SERVER`, `MQTT_PORT`
- `UPLOAD_URL` (API backend `/api/upload-image`)

Luồng hoạt động:
- ESP32-CAM subscribe topic `camera/esp32cam/capture`
- Khi nhận lệnh, camera chụp ảnh JPEG
- Ảnh upload HTTP POST lên backend (`/api/upload-image`)
- Trạng thái camera publish lên `camera/esp32cam/status`

Backend hiện hỗ trợ **2 cơ chế nhận ảnh song song**:
- HTTP: `POST /api/upload-image` (luồng chính firmware `esp32_cam_mqtt` đang dùng)
- MQTT binary compatibility: publish trực tiếp vào `camera/esp32cam/image`

=> Có thể giữ cả 2 để tương thích nhiều firmware/thiết bị.

## Xác thực và bảo mật API

Backend có auth JWT:
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

Hầu hết API điều khiển yêu cầu header:

```http
Authorization: Bearer <token>
```

Lưu ý:
- `JWT_SECRET` đang có fallback mặc định trong code, nên đặt biến môi trường trước khi deploy thật.

## API chính

Auth:
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

Device:
- `GET /api/devices`
- `GET /api/devices/:deviceId`
- `POST /api/devices/:deviceId/control`
- `POST /api/devices/:deviceId/ota`

Camera:
- `POST /api/upload-image` (ESP32-CAM upload JPEG raw)
- `POST /api/camera/capture` (gửi lệnh chụp)
- `GET /api/camera/captures`
- static ảnh: `/captures/<filename>`
- MQTT binary compatibility: `camera/esp32cam/image` (backend vẫn nhận và lưu ảnh)

Firmware:
- `POST /api/firmware/upload` (multipart field `firmware`)
- `GET /api/firmware`
- `GET /api/firmware/:version`

## MQTT topic map

ESP32 -> broker:
- `device/{deviceId}/data`
- `device/{deviceId}/alert`
- `device/{deviceId}/ota/status`

Broker -> ESP32:
- `device/{deviceId}/control`
- `device/{deviceId}/ota`

Camera:
- command: `camera/esp32cam/capture`
- status: `camera/esp32cam/status`
- compatibility input ảnh nhị phân: `camera/esp32cam/image`

Lưu ý:
- Nếu cùng một sự kiện mà thiết bị gửi ảnh qua **cả HTTP và MQTT**, backend sẽ lưu thành 2 file riêng (có thể trùng nội dung ảnh).

## OTA firmware

1. Build file `.bin` từ Arduino IDE (`Sketch -> Export compiled Binary`)
2. Vào dashboard web, upload firmware mới
3. Chọn thiết bị và phiên bản firmware để gửi lệnh OTA
4. Theo dõi tiến trình qua:
   - WebSocket event `ota_status`
   - MQTT topic `device/{deviceId}/ota/status`

Giới hạn upload firmware hiện tại ở backend: `5MB`.

## Chạy nhanh (checklist)

1. Chạy backend (`npm start` trong `backend`)
2. Mở web `http://localhost:3000`, đăng ký tài khoản
3. Nạp firmware `main_mqtt` lên ESP32, cấu hình MQTT về IP máy backend
4. Nạp firmware `esp32_cam_mqtt` lên ESP32-CAM và chỉnh đúng `UPLOAD_URL`
5. Kiểm tra dashboard nhận `device data`, thử control, thử OTA, thử camera capture

## Lưu ý quan trọng

- ESP32/ESP32-CAM phải cùng mạng LAN với máy chạy backend
- Không dùng `localhost` trong firmware, phải dùng IP LAN của máy backend
- Nên mở firewall cho các port `3000`, `1883`, `8888`
- Dữ liệu user SQLite nằm ở `backend/data/users.db`
- Ảnh camera lưu local ở `backend/captures`

