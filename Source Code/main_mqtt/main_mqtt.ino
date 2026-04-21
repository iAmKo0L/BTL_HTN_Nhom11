#define BLYNK_PRINT Serial
// Removed Blynk includes - using MQTT instead

#include <WiFi.h>
#include <WiFiClient.h>
#include <PubSubClient.h>
#include <LiquidCrystal.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <EEPROM.h>
#include <HTTPClient.h>
#include <Update.h>
#include "def.h"
#include "config.h"
#include "mybutton.h"
#include <SimpleKalmanFilter.h>
#include <ESP32Servo.h>
#include <ArduinoJson.h>

//-------------------- Khai báo Kalman Filter----------------------
SimpleKalmanFilter kfilter(2, 2, 0.1);

//-------------------- Khai báo Button-----------------------------
#define buttonPinMENU    5
#define buttonPinDOWN    18
#define buttonPinUP      19
#define buttonPinONOFF   21
#define BUTTON1_ID  1
#define BUTTON2_ID  2
#define BUTTON3_ID  3
#define BUTTON4_ID  4
Button buttonMENU;
Button buttonDOWN;
Button buttonUP;
Button buttonONOFF;
void button_press_short_callback(uint8_t button_id);
void button_press_long_callback(uint8_t button_id);

//----------------------Khai báo LCD1602---------------------------------
#define LCD_RS  15
#define LCD_EN  13
#define LCD_D4  12
#define LCD_D5  14
#define LCD_D6  27
#define LCD_D7  26
LiquidCrystal My_LCD(15, 13, 12, 14, 27, 26);

//------------------------- Khai báo cảm biến ---------------------------
#define SENSOR_MQ2  35
#define SENSOR_FIRE   34
#define SENSOR_FIRE_ON    0
#define SENSOR_FIRE_OFF   1

//-------------------------Khai báo còi ---------------------------------
#define BUZZER  23
#define BUZZER_ON 1
#define BUZZER_OFF 0

//------------------------- Khai báo relay ------------------------------
#define ON 1
#define OFF 0
#define AUTO 1
#define MANUAL 0
bool relay1State = OFF;
bool relay2State = OFF;
bool autoManual = AUTO;
int  mq2Thresshold = 40;
#define THRESSHOLD  4000

// ------------------------ Khai báo servo -----------------------------
Servo myservo1; 
Servo myservo2; 
int windowState = OFF;

//------------------------- Khai báo wifi và MQTT -----------------------
WebServer server(80);
WiFiClient espClient;
PubSubClient mqttClient(espClient);

#define AP_MODE 0
#define STA_MODE 1
bool AP_STA_MODE = 1;

#define MODE_WIFI  0
#define MODE_NOWIFI  1
bool modeWIFI = MODE_NOWIFI;
bool tryCbWIFI = MODE_NOWIFI;

// MQTT Configuration
String mqtt_server_str = "192.168.0.220";  // Thay đổi IP của MQTT broker
const int mqtt_port = 1883;
String deviceId = "ESP32_" + String((uint32_t)ESP.getEfuseMac(), HEX);
String mqttDataTopic = "device/" + deviceId + "/data";
String mqttControlTopic = "device/" + deviceId + "/control";
String mqttOTATopic = "device/" + deviceId + "/ota";
String mqttOTAStatusTopic = "device/" + deviceId + "/ota/status";
String mqttCameraCaptureTopic = "camera/esp32cam/capture";

unsigned long lastCameraTrigger = 0;
const unsigned long cameraTriggerCooldownMs = 10000;

// OTA Update
bool otaInProgress = false;
String otaUrl = "";
String otaVersion = "";

//---------------------- Nguyên mẫu hàm  ---------------------------------
void TaskButton(void *pvParameters);
void TaskMQTT(void *pvParameters);
void TaskMainDisplay(void *pvParameters);
void TaskSwitchAPtoSTA(void *pvParameters);
void D_AP_SER_Page();
void Get_Req();
void readEEPROM();
void ClearEeprom();
void connectSTA();
int  readMQ2();
void sendDatatoMQTT();
void LCD1602_Init();
void LCDPrint(int hang, int cot, char *text, int clearOrNot);
void controlRelay(int relay, int state);
void closeWindow();
void openWindow();
void printRelayState();
void printMode();
void controlWindow(int onoff);
void mqttCallback(char* topic, byte* payload, unsigned int length);
void reconnectMQTT();
void handleOTAUpdate(String url);
void sendOTAStatus(String status, String message);
void triggerCameraCapture(const char *reason);
void TaskBuzzer(void *pvParameters);

//-------------------- Khai báo biến freeRTOS ----------------------------
TaskHandle_t TaskMainDisplay_handle = NULL;
TaskHandle_t TaskButton_handle = NULL;

void setup() {  
  Serial.begin(115200);
  EEPROM.begin(512);
  LCD1602_Init();
  delay(2000);
  My_LCD.clear();
  
  //---------- Khai báp WiFi ---------
  Serial.println("Configuring access point...");
  WiFi.mode(WIFI_AP_STA);

  //---------- Khai báo relay --------
  pinMode(RELAY1, OUTPUT);                 
  pinMode(RELAY2, OUTPUT);
  controlRelay(RELAY1, OFF);
  controlRelay(RELAY2, OFF);

  //---------- Khai báo BUZZER --------
  pinMode(BUZZER, OUTPUT);  
  digitalWrite(BUZZER, BUZZER_OFF);

  //----------- Khai báo cảm biến lửa -------
  pinMode(SENSOR_FIRE, INPUT_PULLUP);  
  digitalWrite(SENSOR_FIRE, BUZZER_OFF);
  
  // ---------- Khai báo Servo --------------
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  myservo1.setPeriodHertz(50);  
  myservo2.setPeriodHertz(50);  
  myservo1.attach(SERVO1, 500, 2400);
  myservo2.attach(SERVO2, 500, 2400);
  closeWindow();
  
  // ---------- Kết nối WiFi ---------
  readEEPROM();
  connectSTA();

  //----------- Read thresshold from EEPROM --------
  mq2Thresshold = EEPROM.read(202) * 100 + EEPROM.read(203);
  Serial.println(" mq2Thresshold ");
  Serial.println(mq2Thresshold);

  if(mq2Thresshold > 9999) mq2Thresshold = THRESSHOLD;

  //----------- Read AUTO/MANUAL EEPROM --------
  autoManual = EEPROM.read(201);
  if(autoManual > 1) autoManual = AUTO;
  Serial.println(autoManual);
  
  // ---------- Khai báo MQTT ---------
  mqttClient.setServer(mqtt_server_str.c_str(), mqtt_port);
  mqttClient.setCallback(mqttCallback);
  
  // ---------- Khai báo hàm FreeRTOS ---------
  xTaskCreatePinnedToCore(TaskMainDisplay,    "TaskMainDisplay" ,  1024*4 ,  NULL,  5 ,  &TaskMainDisplay_handle  , 0 );
  xTaskCreatePinnedToCore(TaskSwitchAPtoSTA,  "TaskSwitchAPtoSTA" , 1024*4 ,  NULL,  5 ,  NULL ,  0);
  xTaskCreatePinnedToCore(TaskBuzzer,         "TaskBuzzer" , 1024*2 ,  NULL,  5 ,  NULL ,  0);
  xTaskCreatePinnedToCore(TaskButton,         "TaskButton" ,       1024*4 ,  NULL,  5 ,  &TaskButton_handle ,  0);
  xTaskCreatePinnedToCore(TaskMQTT,           "TaskMQTT" ,         1024*4 ,  NULL,  5 ,  NULL ,  1);
}

void loop() {
     vTaskDelete(NULL);
}

//------------------------------------------------------------------------------
//---------------------------Task Switch AP to STA -----------------------------

void D_AP_SER_Page() {
    int Tnetwork=0,i=0,len=0;
    String st="",s="";
    Tnetwork = WiFi.scanNetworks();
    st = "<ul>";
    for (int i = 0; i < Tnetwork; ++i) {
      st += "<li>";
      st +=i + 1;
      st += ": ";
      st += WiFi.SSID(i);
      st += " (";
      st += WiFi.RSSI(i);
      st += ")";
      st += (WiFi.encryptionType(i) == WIFI_AUTH_OPEN)?" ":"*";
      st += "</li>";
    }
    st += "</ul>";
   IPAddress ip = WiFi.softAPIP();
      s = "<!DOCTYPE html>\r\n";
      s += "<html lang='en'>\r\n";
      s += "<head>\r\n";
      s += "<meta charset='UTF-8'>\r\n";
      s += "<meta name='viewport' content='width=device-width, initial-scale=1.0'>\r\n";
      s += "<title>GAS DETECTION SYSTEM</title>\r\n";
      s += "<style>\r\n";
      s += "body { font-family: Arial, sans-serif; background-color: #f2f2f2; text-align: center; padding: 20px; }\r\n";
      s += "h1 { color: #333; }\r\n";
      s += "form { background: #fff; display: inline-block; padding: 40px; border-radius: 15px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }\r\n";
      s += "label { font-size: 24px; display: block; margin: 15px 0 5px; text-align: left; }\r\n";
      s += "input[type='text'], input[type='password'] { width: 100%; padding: 15px; font-size: 24px; border: 1px solid #ccc; border-radius: 8px; }\r\n";
      s += "input[type='submit'] { margin-top: 20px; font-size: 24px; padding: 15px 30px; background-color: #4CAF50; color: white; border: none; border-radius: 8px; cursor: pointer; }\r\n";
      s += "input[type='submit']:hover { background-color: #45a049; }\r\n";
      s += "</style>\r\n";
      s += "</head>\r\n";
      s += "<body>\r\n";
      s += "<h1>GAS DETECTION SYSTEM</h1>\r\n";
      s += "<p>" + st + "</p>\r\n";
      s += "<h1>Configure WiFi and MQTT Server</h1>\r\n";
      s += "<form method='get' action='a'>\r\n";
      s += "<label for='ssid'>SSID:</label>\r\n";
      s += "<input type='text' id='ssid' name='ssid' maxlength='32'>\r\n";
      s += "<label for='pass'>Password:</label>\r\n";
      s += "<input type='text' id='pass' name='pass' maxlength='64'>\r\n";
      s += "<label for='mqtt'>MQTT Server IP:</label>\r\n";
      s += "<input type='text' id='mqtt' name='mqtt' maxlength='64' placeholder='192.168.1.100'>\r\n";
      s += "<input type='submit' value='Save'>\r\n";
      s += "</form>\r\n";
      s += "</body>\r\n";
      s += "</html>\r\n";
      
    server.send( 200 , "text/html", s);
}

void Get_Req() {
  vTaskSuspend(TaskMainDisplay_handle);
  if (server.hasArg("ssid") && server.hasArg("pass") && server.hasArg("mqtt")) {  
     sssid=server.arg("ssid");
     passs=server.arg("pass");
     token=server.arg("mqtt");  // Reuse token variable for MQTT server
     Serial.println(sssid);
     Serial.println(passs);
     Serial.println(token);  
  }
  LCDPrint(0,0,"config Wifi STA",1);
  LCDPrint(1,0," please check ",0);
  delay(2000);
  LCDPrint(0,0,(char*)sssid.c_str(),1);
  LCDPrint(1,0,(char*)passs.c_str(),0);
  delay(5000);
  if(sssid.length()>1 && passs.length()>1 && token.length()>1) {
     ClearEeprom();
     delay(10);
     for (int i = 0; i < sssid.length(); ++i)
         EEPROM.write(i, sssid[i]);  
     for (int i = 0; i < passs.length(); ++i)
        EEPROM.write(32+i, passs[i]);
     for (int i = 0; i < token.length(); ++i)
        EEPROM.write(64+i, token[i]);
    
     EEPROM.commit();
        
     String s = "\r\n\r\n<!DOCTYPE HTML>\r\n<html><h1>GAS DETECTION SYSTEM</h1> ";
     s += "<p>Password Saved... Reset to boot into new wifi</html>\r\n\r\n";
     server.send(200,"text/html",s);
   }
   LCDPrint(0,1," RESTART ",1);
   delay(2000);
   LCDPrint(1,1,"   DONE ",0);
   delay(2000);
   ESP.restart();
}

void connectSTA() {
      if ( Essid.length() > 1 ) {  
      Serial.println(Essid);
      Serial.println(Epass);
      Serial.println(Etoken);
      
      WiFi.begin(Essid.c_str(), Epass.c_str());
      int countConnect = 0;
      String dotConnect = "";
      while (WiFi.status() != WL_CONNECTED) {
          LCDPrint(0,0,"WiFi connecting ",0);
          delay(500);
          dotConnect += ".";
          if(dotConnect.length() > 15) {
              dotConnect = "";
              My_LCD.clear();
          }
          LCDPrint(1,0,(char*)dotConnect.c_str(),0);       
          if(countConnect++  == 20) {
            Serial.println("Connect fail, please check ssid and pass");
            LCDPrint(0,0,"Disconnect Wifi",1);
            LCDPrint(1,0," check again",0);
            delay(2000);
            LCDPrint(0,0,"connect WF:ESP32",1);
            LCDPrint(1,0,"192.168.4.1",0);
            delay(2000);
            break;
          }
      }
      Serial.println("");
      if(WiFi.status() == WL_CONNECTED) {
        Serial.println("WiFi connected.");
        Serial.println("IP address: ");
        Serial.println(WiFi.localIP()); 
        LCDPrint(0,1,"WiFi Connected",1);
        LCDPrint(1,0,(char*)Essid.c_str(),0);
        delay(2000);
        
        // Update MQTT server from EEPROM
        if(Etoken.length() > 0) {
          mqtt_server_str = Etoken;
        }
        mqttClient.setServer(mqtt_server_str.c_str(), mqtt_port);
        
        AP_STA_MODE = STA_MODE;
      }
      else
        switchAPMode(); 
    }
}

void switchAPMode() {
   WiFi.softAP(ssid, pass);
   delay(100);
   server.on("/",D_AP_SER_Page);
   server.on("/a",Get_Req); 
   Serial.println("In Ap Mode");
   server.begin();  
   delay(300);
}

void readEEPROM() {
    for (int i = 0; i < 32; ++i)
        Essid += char(EEPROM.read(i)); 
    for (int i = 32; i < 64; ++i)
        Epass += char(EEPROM.read(i)); 
    for (int i = 64; i < 96; ++i)
        Etoken += char(EEPROM.read(i)); 
}

void ClearEeprom() {
     Serial.println("Clearing Eeprom");
     for (int i = 0; i < 96; ++i) { EEPROM.write(i, 0); }
}

void writeThresHoldEEPROM(int mq2Thresshold)
{
    int firstTwoDigits = mq2Thresshold / 100;
    int lastTwoDigits  = mq2Thresshold % 100;
    EEPROM.write(202, firstTwoDigits);
    EEPROM.write(203, lastTwoDigits);
    EEPROM.commit();
    Serial.println(mq2Thresshold);
}

void TaskSwitchAPtoSTA(void *pvParameters) {
    while(1) {
        server.handleClient();   
        vTaskDelay(10/portTICK_PERIOD_MS);
    }
}

//-----------------------------------------------------------------------------
//---------------------------Task MQTT-----------------------------------------

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  
  Serial.print("Message arrived [");
  Serial.print(topic);
  Serial.print("] ");
  Serial.println(message);
  
  String topicStr = String(topic);
  
  if (topicStr == mqttControlTopic) {
    // Parse control command
    DynamicJsonDocument doc(1024);
    deserializeJson(doc, message);
    
    if (doc.containsKey("relay1")) {
      relay1State = doc["relay1"].as<int>();
      digitalWrite(RELAY1, relay1State);
    }
    if (doc.containsKey("relay2")) {
      relay2State = doc["relay2"].as<int>();
      digitalWrite(RELAY2, relay2State);
    }
    if (doc.containsKey("window")) {
      windowState = doc["window"].as<int>();
      controlWindow(windowState);
    }
    if (doc.containsKey("autoManual")) {
      autoManual = doc["autoManual"].as<int>();
      EEPROM.write(201, autoManual);
      EEPROM.commit();
      printMode();
    }
    if (doc.containsKey("threshold")) {
      mq2Thresshold = doc["threshold"].as<int>();
      writeThresHoldEEPROM(mq2Thresshold);
    }
    
    printRelayState();
  }
  else if (topicStr == mqttOTATopic) {
    // Parse OTA command
    DynamicJsonDocument doc(512);
    deserializeJson(doc, message);
    
    if (doc.containsKey("url")) {
      otaUrl = doc["url"].as<String>();
      otaVersion = doc.containsKey("version") ? doc["version"].as<String>() : "";
      otaInProgress = true;
      
      LCDPrint(0,0,"OTA Update...",1);
      LCDPrint(1,0,"Please wait",0);
      
      // Send OTA started notification
      sendOTAStatus("started", "OTA update started");
      
      handleOTAUpdate(otaUrl);
    }
  }
}

void reconnectMQTT() {
  while (!mqttClient.connected() && WiFi.status() == WL_CONNECTED) {
    Serial.print("Attempting MQTT connection...");
    if (mqttClient.connect(deviceId.c_str())) {
      Serial.println("connected");
      LCDPrint(0,0,"MQTT Connected",1);
      delay(1000);
      
      // Subscribe to control and OTA topics
      mqttClient.subscribe(mqttControlTopic.c_str());
      mqttClient.subscribe(mqttOTATopic.c_str());
      Serial.println("Subscribed to control and OTA topics");
    } else {
      Serial.print("failed, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" try again in 5 seconds");
      delay(5000);
    }
  }
}

void sendDatatoMQTT() {
  if (mqttClient.connected()) {
    DynamicJsonDocument doc(512);
    doc["deviceId"] = deviceId;
    doc["gasValue"] = readMQ2();
    doc["fireValue"] = readFireSensor() == SENSOR_FIRE_ON ? 1 : 0;
    doc["relay1State"] = relay1State;
    doc["relay2State"] = relay2State;
    doc["windowState"] = windowState;
    doc["autoManual"] = autoManual;
    doc["threshold"] = mq2Thresshold;
    doc["ipAddress"] = WiFi.localIP().toString();
    
    String jsonString;
    serializeJson(doc, jsonString);
    
    mqttClient.publish(mqttDataTopic.c_str(), jsonString.c_str());
  }
}

void triggerCameraCapture(const char *reason) {
  if (!mqttClient.connected()) {
    return;
  }

  if (millis() - lastCameraTrigger < cameraTriggerCooldownMs) {
    return;
  }

  DynamicJsonDocument doc(256);
  doc["sourceDeviceId"] = deviceId;
  doc["reason"] = reason;
  doc["timestamp"] = millis();

  String payload;
  serializeJson(doc, payload);
  mqttClient.publish(mqttCameraCaptureTopic.c_str(), payload.c_str());
  lastCameraTrigger = millis();
  Serial.println("Camera capture command sent");
}

void TaskMQTT(void *pvParameters) {
  delay(2000); // Wait for WiFi connection
  while(1) {
    if (WiFi.status() == WL_CONNECTED) {
      if (!mqttClient.connected()) {
        reconnectMQTT();
      }
      mqttClient.loop();
    }
    vTaskDelay(100/portTICK_PERIOD_MS);
  }
}

//----------------------------------------------------------------
//----------------------------LCD1602 Init------------------------
void LCDPrint(int hang, int cot, char *text, int clearOrNot) {
   if(clearOrNot == 1)
      My_LCD.clear();
   My_LCD.setCursor(cot, hang);
   My_LCD.print(text);
}

void LCD1602_Init() {
   My_LCD.begin(16, 2);
   My_LCD.clear();
   LCDPrint(0,2, "Gas Detection",0);
   LCDPrint(1,5, "System",0);
}

void printMode() {
   if(autoManual == AUTO)
      LCDPrint(0,15,"A" ,0);
    else
      LCDPrint(0,15,"M" ,0); 
}

void printRelayState() {
    if(relay1State == 0)
      LCDPrint(1,0,"RL1:OFF ", 0);
    else
      LCDPrint(1,0,"RL1:ON " , 0); 
    if(relay2State == 0)
      LCDPrint(1,9,"RL2:OFF " ,0);
    else
      LCDPrint(1,9,"RL2:ON " , 0);
}

int readMQ2() {
    float MQ2_Value = analogRead(SENSOR_MQ2);
    MQ2_Value = map(MQ2_Value, 0 , 4095, 0, 10000 );
    Serial.println(MQ2_Value);
    return MQ2_Value;
}

int readFireSensor() {
    int Fire_Value = digitalRead(SENSOR_FIRE);
    Serial.println(Fire_Value);
    return Fire_Value;
}

void printMQ2() {
    float MQ2_Value = readMQ2();
    LCDPrint(0,0,(char*)("GAS:" + String((int)MQ2_Value) + "ppm ").c_str(),0); 
}

void printWindowState(int windowState)
{
    vTaskSuspend(TaskMainDisplay_handle);
    My_LCD.clear();
    if(windowState == 1)
      LCDPrint(0,2,"OPEN WINDOW",0); 
    else
      LCDPrint(0,2,"CLOSE WINDOW",0); 
    delay(1000);
    My_LCD.clear();
    printMode();printRelayState();printMQ2() ;
    vTaskResume(TaskMainDisplay_handle);
}

//-----------------------Task Main Display and Control Device----------
int checkSensor = 0;
int buzzerON = 0;
int sendNotificationsOnce = 0;
unsigned long lastMQTTSend = 0;

void TaskMainDisplay(void *pvParameters) {
    delay(10000);
    My_LCD.clear();
    printRelayState();
    printMode();
    printMQ2(); 
    
    while(1) {
         if(autoManual == AUTO) {
           
              if(readMQ2() > mq2Thresshold ) {
                 buzzerON = 1;
                 relay1State = ON;  relay2State = OFF; 
                 controlRelay(RELAY1, relay1State);
                 controlRelay(RELAY2, relay2State);
                 windowState = 1; controlWindow(windowState);
                 delay(3000);
              }
              else if(readFireSensor() == SENSOR_FIRE_ON) {
                 buzzerON = 1;
                 relay1State = OFF;  relay2State = ON; 
                 controlRelay(RELAY1, relay1State);
                 controlRelay(RELAY2, relay2State);
                 delay(3000);
              }
              else if(readMQ2() < mq2Thresshold - 100  && readFireSensor() == SENSOR_FIRE_OFF ) {
                 relay1State = OFF;  relay2State = OFF; 
                 controlRelay(RELAY1, relay1State);
                 controlRelay(RELAY2, relay2State);
                 windowState = 0; controlWindow(windowState);
              }
         }
          if(readMQ2() > mq2Thresshold && readFireSensor() == SENSOR_FIRE_ON) {
            if(sendNotificationsOnce == 0) {
              // Send notification via MQTT
              if (mqttClient.connected()) {
                mqttClient.publish((String("device/") + deviceId + "/alert").c_str(), 
                                 "Fire & Gas detected");
                triggerCameraCapture("fire_and_gas");
              }
            }
            sendNotificationsOnce = 1;
            My_LCD.clear();
            LCDPrint(0,4, "WARNING",0 );
            LCDPrint(1,2, "GAS DETECTED",0 );
            buzzerON = 1;
            delay(500);
            My_LCD.clear();
            Serial.println("WARNING Fire & Gas detected");
            LCDPrint(0,4, "WARNING",0 );
            LCDPrint(1,2, "FIRE DETECTED",0 );
            delay(500);
          }
          else if(readMQ2() > mq2Thresshold && readFireSensor() == SENSOR_FIRE_OFF) {
            if(sendNotificationsOnce == 0) {
              if (mqttClient.connected()) {
                mqttClient.publish((String("device/") + deviceId + "/alert").c_str(), 
                                 "Gas exceeds permissible limits");
              }
            }
            sendNotificationsOnce = 1;
            Serial.println("WARNING Gas exceeds permissible limits");
            My_LCD.clear();
            delay(500);
            LCDPrint(0,4, "WARNING",0 );
            LCDPrint(1,2, "GAS DETECTED",0 );
            buzzerON = 1;
          }
          else if(readMQ2() < mq2Thresshold - 100 && readFireSensor()== SENSOR_FIRE_ON) {
            if(sendNotificationsOnce == 0) {
              if (mqttClient.connected()) {
                mqttClient.publish((String("device/") + deviceId + "/alert").c_str(), 
                                 "Fire detected");
                triggerCameraCapture("fire_detected");
              }
            }
            sendNotificationsOnce = 1;
            My_LCD.clear();
            delay(500);
            Serial.println("WARNING Fire Fire");
            LCDPrint(0,4, "WARNING",0 );
            LCDPrint(1,2, "FIRE DETECTED",0 );
            buzzerON = 1;
          }
          else if(readMQ2() < mq2Thresshold - 100 && readFireSensor() == SENSOR_FIRE_OFF ) {
            My_LCD.clear(); delay(20);
            printRelayState(); delay(20);
            printMode(); delay(20);
            printMQ2(); delay(20);
            buzzerON = 0;
            sendNotificationsOnce = 0;
         }
         
         // Send data to MQTT every 2 seconds
         if (millis() - lastMQTTSend > 2000) {
           sendDatatoMQTT();
           lastMQTTSend = millis();
         }
         
         delay(2000);
    }
}

void TaskBuzzer(void *pvParameters) {
   while(1) {
      if(buzzerON == 1)
        buzzerWarning();
      else
        digitalWrite(BUZZER, BUZZER_OFF);
      delay(10);
   }
}

//----------------------------------------------------------------
//----------------------Task Button-------------------------------
void TaskButton(void *pvParameters) {
    pinMode(buttonPinMENU, INPUT);
    pinMode(buttonPinDOWN, INPUT);
    pinMode(buttonPinUP, INPUT);
    pinMode(buttonPinONOFF, INPUT);
    button_init(&buttonMENU, buttonPinMENU, BUTTON1_ID);
    button_init(&buttonDOWN, buttonPinDOWN, BUTTON2_ID);
    button_init(&buttonUP,   buttonPinUP,   BUTTON3_ID);
    button_init(&buttonONOFF,buttonPinONOFF,BUTTON4_ID);
    button_pressshort_set_callback((void *)button_press_short_callback);
    button_presslong_set_callback((void *)button_press_long_callback);

    while(1) {
      handle_button(&buttonMENU);
      handle_button(&buttonDOWN);
      handle_button(&buttonUP);
      handle_button(&buttonONOFF);
      vTaskDelay(10/portTICK_PERIOD_MS);
   }
}

void controlRelay(int relay, int state) {
    digitalWrite(relay,state);
}

void openWindow() {
    myservo1.write(0); 
    myservo2.write(180);
}

void closeWindow() {
    myservo1.write(90); 
    myservo2.write(90);
}

void controlWindow(int onoff) {
    if(onoff == 0)
      closeWindow();
    else
      openWindow();
}

void buzzerBip() {
    //digitalWrite(BUZZER, BUZZER_ON);delay(300);
    //digitalWrite(BUZZER, BUZZER_OFF);
}

void buzzerWarning() {
    digitalWrite(BUZZER, BUZZER_ON); delay(2000);
    digitalWrite(BUZZER, BUZZER_OFF);delay(500);
}

int modeSetThresHold   = 0;

void button_press_short_callback(uint8_t button_id) {
      switch(button_id) {
        case BUTTON1_ID :
          Serial.println("bt1 press short");
          buzzerBip();
          modeSetThresHold = 1 - modeSetThresHold;
          if(modeSetThresHold == 1) {
              vTaskSuspend(TaskMainDisplay_handle);
              My_LCD.clear();
              delay(100);
              LCDPrint(0,0," SET Thresshold ",0);
              char str[20];
              sprintf(str,"%d",mq2Thresshold);
              LCDPrint(1,6,str,0);
              delay(100);
          }
          else {
              LCDPrint(1,1," SUCCESSFULLY ", 0);  
              delay(1000);
              My_LCD.clear();
              delay(100);
              printMQ2(); delay(20);
              printRelayState(); delay(20);
              printMode(); delay(20);
              writeThresHoldEEPROM(mq2Thresshold);
              sendDatatoMQTT();
              vTaskResume(TaskMainDisplay_handle);
          }
          break;
        case BUTTON2_ID :
          Serial.println("bt2 press short");
          buzzerBip();
          if(modeSetThresHold == 1) {
              My_LCD.clear();
              delay(100);
              LCDPrint(0,0," SET Thresshold ",0);
              char str[20];
              mq2Thresshold += 50;
               if(mq2Thresshold > 9999) mq2Thresshold = 9999;
              sprintf(str,"%d",mq2Thresshold);
              LCDPrint(1,6,str,0);
          }
          else {
            if(autoManual == AUTO)
              autoManual = MANUAL;
            EEPROM.write(201, MANUAL);EEPROM.commit();
            relay1State = 1 - relay1State;
            controlRelay(RELAY1,relay1State);
            sendDatatoMQTT();
            My_LCD.clear(); delay(20);
            printRelayState(); delay(20);
            printMode(); delay(20);
            printMQ2(); delay(20);
          }
          break;
        case BUTTON3_ID :
          Serial.println("bt3 press short");
          buzzerBip();
          if(modeSetThresHold == 1) {
              My_LCD.clear();
              delay(100);
              LCDPrint(0,0," SET Thresshold ",0);
              char str[20];
              mq2Thresshold -= 50;
              if(mq2Thresshold < 200) mq2Thresshold = 200;
              sprintf(str,"%d",mq2Thresshold);
              LCDPrint(1,6,str,0);
          }
          else {
              if(autoManual == AUTO)
                autoManual = MANUAL;
              EEPROM.write(201, MANUAL);EEPROM.commit();
              relay2State = 1 - relay2State;
              controlRelay(RELAY2,relay2State);
              sendDatatoMQTT();
              My_LCD.clear(); delay(20);
              printRelayState(); delay(20);
              printMode(); delay(20);
              printMQ2(); delay(20);
          }
          break;  
        case BUTTON4_ID :
          Serial.println("bt4 press short");
          buzzerBip();
          if(modeSetThresHold == 0) {
            if(autoManual == AUTO)
              autoManual = MANUAL;
            windowState = 1 - windowState;
            controlWindow(windowState);
            sendDatatoMQTT();
            printWindowState(windowState);
          }
          break;     
     } 
} 

void button_press_long_callback(uint8_t button_id)
{
    switch(button_id)
   {  
      case BUTTON1_ID :
        buzzerBip();
        if(modeSetThresHold == 0) {
          AP_STA_MODE = 1 - AP_STA_MODE;
          switch(AP_STA_MODE) {
            case AP_MODE:
              vTaskSuspend(TaskMainDisplay_handle);
              LCDPrint(0,1,"WiFi AP Mode",1);
              delay(2000); 
              LCDPrint(0,0,"connect WF:ESP32",1);
              LCDPrint(1,1,"192.168.4.1",0);
              switchAPMode();
              break;
            case STA_MODE:
              ESP.restart();
              break;
          }
        }
        break;
      case BUTTON2_ID :
        buzzerBip();
        break;
      case BUTTON3_ID :
        buzzerBip();
        break;  
      case BUTTON4_ID :
        buzzerBip();
        if(modeSetThresHold == 0) {
          autoManual = 1 - autoManual;
          EEPROM.write(201, autoManual);EEPROM.commit();
          printMode();
          sendDatatoMQTT();
        }
        break; 
   }   
}

//----------------------------------------------------------------
//----------------------OTA Update Function-----------------------

void handleOTAUpdate(String url) {
  HTTPClient http;
  
  Serial.print("Starting OTA update from: ");
  Serial.println(url);
  
  // Configure HTTP client with timeout
  http.begin(url);
  http.setTimeout(30000); // 30 seconds timeout
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  
  Serial.println("Sending HTTP GET request...");
  int httpCode = http.GET();
  Serial.print("HTTP response code: ");
  Serial.println(httpCode);
  
  if (httpCode == HTTP_CODE_OK) {
    int contentLength = http.getSize();
    Serial.printf("Content length: %d bytes\n", contentLength);
    
    if (contentLength > 0) {
      bool canBegin = Update.begin(contentLength);
      
      if (canBegin) {
        Serial.println("Begin OTA update");
        LCDPrint(0,0,"Downloading...",1);
        
        WiFiClient * stream = http.getStreamPtr();
        size_t written = Update.writeStream(*stream);
        
        if (written == contentLength) {
          Serial.println("Written: " + String(written) + " bytes");
          
          if (Update.end()) {
            Serial.println("OTA done!");
            if (Update.isFinished()) {
              LCDPrint(0,0,"OTA Success!",1);
              LCDPrint(1,0,"Rebooting...",0);
              
              // Send OTA success notification
              sendOTAStatus("success", "OTA update completed successfully");
              mqttClient.loop(); // Process MQTT to ensure message is sent
              delay(100);
              mqttClient.loop(); // Process again
              delay(100);
              mqttClient.loop(); // Final process
              delay(500); // Give MQTT time to send
              ESP.restart();
            } else {
              Serial.println("OTA not finished");
              LCDPrint(0,0,"OTA Failed!",1);
              sendOTAStatus("failed", "OTA update not finished");
              otaInProgress = false;
            }
          } else {
            Serial.println("Error Occurred. Error #: " + String(Update.getError()));
            LCDPrint(0,0,"OTA Error!",1);
            sendOTAStatus("failed", "OTA error: " + String(Update.getError()));
            otaInProgress = false;
          }
        } else {
          Serial.println("Written only: " + String(written) + "/" + String(contentLength));
          LCDPrint(0,0,"Download Failed",1);
          sendOTAStatus("failed", "Download incomplete: " + String(written) + "/" + String(contentLength));
          otaInProgress = false;
        }
      } else {
        Serial.println("Not enough space to begin OTA");
        LCDPrint(0,0,"No Space!",1);
        sendOTAStatus("failed", "Not enough space to begin OTA");
        otaInProgress = false;
      }
    } else {
      Serial.println("Content-Length not defined");
      LCDPrint(0,0,"Invalid File",1);
      sendOTAStatus("failed", "Invalid file: Content-Length not defined");
      otaInProgress = false;
    }
  } else {
    Serial.printf("HTTP error: %d\n", httpCode);
    LCDPrint(0,0,"HTTP Error",1);
    sendOTAStatus("failed", "HTTP error: " + String(httpCode));
    otaInProgress = false;
  }
  
  http.end();
}

// Send OTA status to MQTT
void sendOTAStatus(String status, String message) {
  if (mqttClient.connected()) {
    DynamicJsonDocument doc(256);
    doc["status"] = status;
    doc["message"] = message;
    doc["timestamp"] = millis();
    doc["version"] = otaVersion;
    
    String jsonString;
    serializeJson(doc, jsonString);
    
    mqttClient.publish(mqttOTAStatusTopic.c_str(), jsonString.c_str());
    Serial.println("OTA Status: " + status + " - " + message);
  }
}

