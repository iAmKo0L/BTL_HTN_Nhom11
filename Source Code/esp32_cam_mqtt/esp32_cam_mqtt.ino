#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include "esp_camera.h"

// ================== WiFi + MQTT + HTTP config ==================
const char* WIFI_SSID = "Sibun";
const char* WIFI_PASS = "11112004";

const char* MQTT_SERVER = "192.168.0.220";
const int MQTT_PORT = 1883;

// API backend để upload ảnh
const char* UPLOAD_URL = "http://192.168.0.220:3000/api/upload-image";

String cameraDeviceId = "ESP32CAM_" + String((uint32_t)(ESP.getEfuseMac() & 0xFFFFFFFF), HEX);
String mqttCaptureTopic = "camera/esp32cam/capture";
String mqttStatusTopic  = "camera/esp32cam/status";

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// ================== AI Thinker ESP32-CAM pins ==================
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27

#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

bool cameraInitialized = false;
volatile bool captureRequested = false;

String pendingCaptureReason = "manual";
String pendingEventId = "";
String pendingSource = "";

// ================== Helpers ==================
void publishStatus(const char* status, const String& message, const String& eventId = "") {
  if (!mqttClient.connected()) return;

  StaticJsonDocument<384> doc;
  doc["deviceId"] = cameraDeviceId;
  doc["status"] = status;
  doc["message"] = message;
  doc["eventId"] = eventId;
  doc["ip"] = WiFi.localIP().toString();
  doc["timestamp"] = millis();

  String payload;
  serializeJson(doc, payload);
  mqttClient.publish(mqttStatusTopic.c_str(), payload.c_str(), true);
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("Connecting WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("WiFi connected, IP: ");
  Serial.println(WiFi.localIP());
}

bool initCamera() {
  // power cycle sensor
  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, HIGH);
  delay(100);
  digitalWrite(PWDN_GPIO_NUM, LOW);
  delay(100);

  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;

  // Thử 20MHz trước, nếu board bạn vẫn lỗi thì đổi lại 10000000
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  // giữ ảnh nhỏ để ổn định
  config.frame_size   = FRAMESIZE_VGA;
  config.jpeg_quality = 12;
  config.fb_count     = 1;
  config.fb_location  = CAMERA_FB_IN_DRAM;
#if defined(CAMERA_GRAB_WHEN_EMPTY)
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
#endif

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return false;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s != nullptr) {
    Serial.printf("Sensor PID: 0x%02X\n", s->id.PID);

    if (s->id.PID == OV3660_PID) {
      s->set_vflip(s, 1);
      s->set_brightness(s, 1);
      s->set_saturation(s, -2);
    }

    s->set_framesize(s, FRAMESIZE_QQVGA);
  }

  cameraInitialized = true;
  Serial.println("Camera initialized");
  return true;
}

void deinitCamera() {
  if (!cameraInitialized) return;

  esp_camera_deinit();
  digitalWrite(PWDN_GPIO_NUM, HIGH);
  cameraInitialized = false;
  Serial.println("Camera deinitialized");
}

bool uploadImageHTTP(camera_fb_t *fb, const String& reason, const String& eventId, const String& source) {
  if (!fb || fb->len == 0) return false;
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  WiFiClient client;

  if (!http.begin(client, UPLOAD_URL)) {
    Serial.println("HTTP begin failed");
    return false;
  }

  http.setTimeout(15000);
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Event-Id", eventId);
  http.addHeader("X-Device-Id", cameraDeviceId);
  http.addHeader("X-Reason", reason);
  http.addHeader("X-Source", source);

  int httpCode = http.POST(fb->buf, fb->len);
  String response = http.getString();

  Serial.printf("HTTP upload code: %d\n", httpCode);
  Serial.println(response);

  http.end();
  return (httpCode >= 200 && httpCode < 300);
}

void captureAndUploadImage(const String& reason, const String& eventId, const String& source) {
  if (!cameraInitialized) {
    if (!initCamera()) {
      publishStatus("failed", "Camera init failed", eventId);
      return;
    }
  }

  delay(200);

  // warmup frame
  camera_fb_t *warmup = esp_camera_fb_get();
  if (warmup) {
    esp_camera_fb_return(warmup);
    delay(100);
  }

  camera_fb_t *fb = nullptr;
  for (int attempt = 1; attempt <= 3 && !fb; attempt++) {
    fb = esp_camera_fb_get();
    if (!fb) {
      Serial.printf("Capture attempt %d failed\n", attempt);
      delay(200);
    }
  }

  if (!fb) {
    Serial.println("Capture failed");
    publishStatus("failed", "Capture failed", eventId);
    deinitCamera();
    return;
  }

  Serial.printf("Captured image size: %u bytes\n", fb->len);

  bool ok = uploadImageHTTP(fb, reason, eventId, source);
  esp_camera_fb_return(fb);

  if (ok) {
    String msg = "Image uploaded. reason=" + reason + ", eventId=" + eventId;
    publishStatus("success", msg, eventId);
  } else {
    publishStatus("failed", "HTTP upload failed", eventId);
  }

  deinitCamera();
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String topicStr(topic);
  String message = "";

  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  Serial.print("MQTT msg [");
  Serial.print(topicStr);
  Serial.print("] ");
  Serial.println(message);

  if (topicStr == mqttCaptureTopic) {
    StaticJsonDocument<384> doc;
    String reason = "manual";
    String eventId = "evt_" + String(millis());
    String source = "server";

    DeserializationError err = deserializeJson(doc, message);
    if (!err) {
      if (doc.containsKey("reason"))  reason = doc["reason"].as<String>();
      if (doc.containsKey("eventId")) eventId = doc["eventId"].as<String>();
      if (doc.containsKey("source"))  source = doc["source"].as<String>();
    }

    pendingCaptureReason = reason;
    pendingEventId = eventId;
    pendingSource = source;
    captureRequested = true;

    Serial.println("Capture request queued");
  }
}

void reconnectMQTT() {
  while (!mqttClient.connected()) {
    Serial.print("Attempt MQTT connection...");

    if (mqttClient.connect(cameraDeviceId.c_str())) {
      Serial.println("connected");
      mqttClient.subscribe(mqttCaptureTopic.c_str());
      publishStatus("online", "ESP32-CAM connected");
    } else {
      Serial.print("failed, rc=");
      Serial.print(mqttClient.state());
      Serial.println(", retry in 5s");
      delay(5000);
    }
  }
}

// ================== Arduino ==================
void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, HIGH);

  connectWiFi();

  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);

  Serial.println("ESP32-CAM firmware ready (camera idle until capture request)");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  if (!mqttClient.connected()) {
    reconnectMQTT();
  }

  mqttClient.loop();

  if (captureRequested && mqttClient.connected()) {
    captureRequested = false;
    captureAndUploadImage(pendingCaptureReason, pendingEventId, pendingSource);
  }

  delay(10);
}