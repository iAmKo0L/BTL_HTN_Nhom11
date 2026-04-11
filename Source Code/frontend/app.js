// WebSocket connection
const WS_URL = 'ws://localhost:8888';
const API_URL = 'http://localhost:3000/api';
const token = localStorage.getItem('token');

if (!token && !window.location.pathname.endsWith('auth.html')) {
    window.location.href = './auth.html';
}

let ws = null;
let currentDeviceId = null;
let deviceStatus = {};

function authHeaders(extra = {}) {
    return {
        ...extra,
        Authorization: `Bearer ${token}`
    };
}

function handleAuthFailure(response) {
    if (response && response.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = './auth.html';
        return true;
    }
    return false;
}

// Initialize WebSocket connection
function initWebSocket() {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
        console.log('WebSocket connected');
        updateConnectionStatus(true);
        showAlert('Kết nối thành công!', 'success');
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateConnectionStatus(false);
    };
    
    ws.onclose = () => {
        console.log('WebSocket disconnected');
        updateConnectionStatus(false);
        // Reconnect after 3 seconds
        setTimeout(initWebSocket, 3000);
    };
}

function updateConnectionStatus(connected) {
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.getElementById('statusText');
    
    if (connected) {
        statusDot.classList.add('connected');
        statusDot.classList.remove('disconnected');
        statusText.textContent = 'Đã kết nối';
    } else {
        statusDot.classList.add('disconnected');
        statusDot.classList.remove('connected');
        statusText.textContent = 'Mất kết nối';
    }
}

function handleWebSocketMessage(data) {
    console.log('WebSocket message received:', data);
    
    switch (data.type) {
        case 'device_list':
            updateDeviceList(data.devices);
            break;
        case 'device_data':
            if (data.deviceId === currentDeviceId) {
                updateDeviceData(data.data);
            }
            break;
        case 'device_disconnected':
            if (data.deviceId === currentDeviceId) {
                showAlert('Thiết bị đã ngắt kết nối', 'warning');
            }
            break;
        case 'ota_status':
            console.log('OTA status received:', data, 'currentDeviceId:', currentDeviceId);
            if (data.deviceId === currentDeviceId) {
                handleOTAStatus(data);
            } else {
                console.log('OTA status for different device. Expected:', currentDeviceId, 'Got:', data.deviceId);
            }
            break;
        case 'error':
            showAlert(data.message, 'error');
            break;
    }
}

function handleOTAStatus(data) {
    // Clear timeout if status received
    if (otaUpdateTimeout) {
        clearTimeout(otaUpdateTimeout);
        otaUpdateTimeout = null;
    }
    
    const statusDiv = document.getElementById('otaStatus');
    if (!statusDiv) return;
    
    statusDiv.className = 'ota-status active';
    
    switch (data.status) {
        case 'started':
            statusDiv.className += ' info';
            statusDiv.textContent = '🔄 Đang tải firmware...';
            showAlert('ESP32 đã bắt đầu tải firmware', 'info');
            break;
        case 'success':
            statusDiv.className += ' success';
            statusDiv.textContent = `✅ Cập nhật thành công! Phiên bản: v${data.version || 'N/A'}. Thiết bị đang khởi động lại...`;
            showAlert('✅ Cập nhật firmware thành công! Thiết bị đang khởi động lại...', 'success');
            break;
        case 'failed':
            statusDiv.className += ' error';
            statusDiv.textContent = `❌ Cập nhật thất bại: ${data.message}`;
            showAlert('❌ Cập nhật firmware thất bại: ' + data.message, 'error');
            break;
        default:
            statusDiv.textContent = `Trạng thái: ${data.status} - ${data.message}`;
    }
}

function updateDeviceList(devices) {
    const select = document.getElementById('deviceSelect');
    select.innerHTML = '<option value="">-- Chọn thiết bị --</option>';
    
    devices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = `Thiết bị: ${device.deviceId}`;
        select.appendChild(option);
    });
    
    if (devices.length > 0 && !currentDeviceId) {
        currentDeviceId = devices[0].deviceId;
        select.value = currentDeviceId;
        loadDeviceStatus(currentDeviceId);
    }
}

document.getElementById('deviceSelect').addEventListener('change', (e) => {
    currentDeviceId = e.target.value;
    if (currentDeviceId) {
        loadDeviceStatus(currentDeviceId);
    }
});

async function loadDeviceStatus(deviceId) {
    try {
        const response = await fetch(`${API_URL}/devices/${deviceId}`, {
            headers: authHeaders()
        });
        if (handleAuthFailure(response)) return;
        const data = await response.json();
        updateDeviceData(data);
    } catch (error) {
        console.error('Error loading device status:', error);
    }
}

function updateDeviceData(data) {
    deviceStatus = data;
    
    // Update sensor values
    if (data.gasValue !== undefined) {
        document.getElementById('gasValue').textContent = `${data.gasValue} ppm`;
        updateGasProgress(data.gasValue, data.threshold || 4000);
    }
    
    if (data.fireValue !== undefined) {
        document.getElementById('fireValue').textContent = data.fireValue ? 'CÓ LỬA' : 'KHÔNG CÓ LỬA';
        document.getElementById('fireValue').style.color = data.fireValue ? '#f44336' : '#4CAF50';
    }
    
    // Update threshold
    if (data.threshold !== undefined) {
        document.getElementById('thresholdInput').value = data.threshold;
    }
    
    // Update relay states
    if (data.relay1State !== undefined) {
        const btn1 = document.getElementById('relay1Btn');
        btn1.textContent = data.relay1State ? 'BẬT' : 'TẮT';
        btn1.className = `btn-toggle ${data.relay1State ? 'on' : 'off'}`;
    }
    
    if (data.relay2State !== undefined) {
        const btn2 = document.getElementById('relay2Btn');
        btn2.textContent = data.relay2State ? 'BẬT' : 'TẮT';
        btn2.className = `btn-toggle ${data.relay2State ? 'on' : 'off'}`;
    }
    
    // Update window state
    if (data.windowState !== undefined) {
        const windowBtn = document.getElementById('windowBtn');
        windowBtn.textContent = data.windowState ? 'MỞ' : 'ĐÓNG';
        windowBtn.className = `btn-toggle ${data.windowState ? 'on' : 'off'}`;
    }
    
    // Update auto/manual mode
    if (data.autoManual !== undefined) {
        document.getElementById('autoManualToggle').checked = data.autoManual === 1;
    }
    
    // Update device info
    if (data.deviceId) {
        document.getElementById('deviceId').textContent = data.deviceId;
    }
    if (data.ipAddress) {
        document.getElementById('deviceIP').textContent = data.ipAddress;
    }
    if (data.lastUpdate) {
        const date = new Date(data.lastUpdate);
        document.getElementById('lastUpdate').textContent = date.toLocaleString('vi-VN');
    }
}

function updateGasProgress(value, threshold) {
    const progress = document.getElementById('gasProgress');
    const percentage = Math.min((value / 10000) * 100, 100);
    progress.style.width = `${percentage}%`;
    
    if (value > threshold) {
        progress.className = 'progress danger';
    } else if (value > threshold * 0.7) {
        progress.className = 'progress warning';
    } else {
        progress.className = 'progress';
    }
}

function sendControlCommand(command) {
    if (!currentDeviceId) {
        showAlert('Vui lòng chọn thiết bị', 'warning');
        return;
    }
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'control',
            deviceId: currentDeviceId,
            ...command
        }));
    } else {
        // Fallback to HTTP API
        fetch(`${API_URL}/devices/${currentDeviceId}/control`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(command)
        })
        .then(response => {
            if (handleAuthFailure(response)) return null;
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.json();
        })
        .catch(error => {
            console.error('Error sending control:', error);
            showAlert('Lỗi gửi lệnh điều khiển', 'error');
        });
    }
}

function toggleRelay(relayNum) {
    const currentState = deviceStatus[`relay${relayNum}State`] || 0;
    const newState = currentState === 0 ? 1 : 0;
    
    const command = {
        relay1: relayNum === 1 ? newState : deviceStatus.relay1State,
        relay2: relayNum === 2 ? newState : deviceStatus.relay2State,
        autoManual: 0 // Manual mode
    };
    
    sendControlCommand(command);
}

function toggleWindow() {
    const currentState = deviceStatus.windowState || 0;
    const newState = currentState === 0 ? 1 : 0;
    
    sendControlCommand({
        window: newState,
        autoManual: 0 // Manual mode
    });
}

function updateThreshold() {
    const threshold = parseInt(document.getElementById('thresholdInput').value);
    if (isNaN(threshold) || threshold < 0 || threshold > 10000) {
        showAlert('Ngưỡng không hợp lệ (0-10000)', 'error');
        return;
    }
    
    sendControlCommand({
        threshold: threshold
    });
    
    showAlert('Đã cập nhật ngưỡng', 'success');
}

document.getElementById('autoManualToggle').addEventListener('change', (e) => {
    const autoManual = e.target.checked ? 1 : 0;
    sendControlCommand({ autoManual: autoManual });
});

// Make uploadFirmware available globally
async function uploadFirmware() {
    const fileInput = document.getElementById('firmwareFile');
    const versionInput = document.getElementById('firmwareVersion');
    
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        showAlert('Vui lòng chọn file firmware (.bin)', 'warning');
        return;
    }
    
    const file = fileInput.files[0];
    if (!file.name.endsWith('.bin')) {
        showAlert('File phải có định dạng .bin', 'error');
        return;
    }
    
    const formData = new FormData();
    formData.append('firmware', file);
    if (versionInput && versionInput.value.trim()) {
        formData.append('version', versionInput.value.trim());
    }
    
    const statusDiv = document.getElementById('otaStatus');
    if (statusDiv) {
        statusDiv.className = 'ota-status active';
        statusDiv.textContent = 'Đang upload firmware...';
    }
    
    try {
        const response = await fetch(`${API_URL}/firmware/upload`, {
            method: 'POST',
            headers: authHeaders(),
            body: formData
        });
        if (handleAuthFailure(response)) return;
        
        const result = await response.json();
        
        if (result.success) {
            if (statusDiv) {
                statusDiv.className = 'ota-status active success';
                statusDiv.textContent = `Upload thành công! Phiên bản: v${result.metadata.version}`;
            }
            showAlert('Upload firmware thành công!', 'success');
            
            // Reset form
            fileInput.value = '';
            if (versionInput) versionInput.value = '';
            const fileNameSpan = document.getElementById('fileName');
            if (fileNameSpan) fileNameSpan.textContent = 'Chưa chọn file';
            
            // Reload firmware list
            loadFirmwareList();
        } else {
            throw new Error(result.error || 'Upload failed');
        }
    } catch (error) {
        if (statusDiv) {
            statusDiv.className = 'ota-status active error';
            statusDiv.textContent = `Lỗi: ${error.message}`;
        }
        showAlert('Lỗi upload firmware: ' + error.message, 'error');
    }
}

// Expose to global scope
window.uploadFirmware = uploadFirmware;

async function loadFirmwareList() {
    try {
        const response = await fetch(`${API_URL}/firmware`, {
            headers: authHeaders()
        });
        if (handleAuthFailure(response)) return;
        const firmwareList = await response.json();
        
        const select = document.getElementById('firmwareSelect');
        if (!select) return;
        
        select.innerHTML = '<option value="">-- Chọn firmware --</option>';
        
        if (firmwareList.length === 0) {
            select.innerHTML = '<option value="">-- Chưa có firmware nào --</option>';
            showAlert('Chưa có firmware nào. Vui lòng upload firmware trước.', 'info');
            return;
        }
        
        firmwareList.forEach(fw => {
            const option = document.createElement('option');
            option.value = fw.version;
            const date = new Date(fw.uploadedAt).toLocaleDateString('vi-VN');
            const size = (fw.size / 1024).toFixed(2);
            option.textContent = `v${fw.version} - ${date} (${size} KB)`;
            select.appendChild(option);
        });
        
        showAlert(`Đã tải ${firmwareList.length} phiên bản firmware`, 'success');
    } catch (error) {
        console.error('Error loading firmware list:', error);
        showAlert('Lỗi tải danh sách firmware', 'error');
    }
}

// Expose to global scope
window.loadFirmwareList = loadFirmwareList;

// Track OTA update timeout
let otaUpdateTimeout = null;

async function startOTAUpdate() {
    const firmwareSelect = document.getElementById('firmwareSelect');
    if (!firmwareSelect) {
        showAlert('Không tìm thấy dropdown firmware', 'error');
        return;
    }
    
    const version = firmwareSelect.value;
    if (!version) {
        showAlert('Vui lòng chọn phiên bản firmware', 'warning');
        return;
    }
    
    if (!currentDeviceId) {
        showAlert('Vui lòng chọn thiết bị', 'warning');
        return;
    }
    
    // Clear any existing timeout
    if (otaUpdateTimeout) {
        clearTimeout(otaUpdateTimeout);
        otaUpdateTimeout = null;
    }
    
    const statusDiv = document.getElementById('otaStatus');
    if (statusDiv) {
        statusDiv.className = 'ota-status active info';
        statusDiv.textContent = 'Đang gửi lệnh cập nhật...';
    }
    
    try {
        const response = await fetch(`${API_URL}/devices/${currentDeviceId}/ota`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ version: version })
        });
        if (handleAuthFailure(response)) return;
        
        const result = await response.json();
        
        if (result.success) {
            if (statusDiv) {
                statusDiv.className = 'ota-status active info';
                statusDiv.textContent = `Đã gửi lệnh cập nhật firmware v${version}. Đang chờ thiết bị phản hồi...`;
            }
            showAlert('Lệnh OTA đã được gửi', 'success');
            
            // Set timeout to update status if no response received
            otaUpdateTimeout = setTimeout(() => {
                const currentStatus = document.getElementById('otaStatus');
                if (currentStatus && currentStatus.textContent.includes('Đang chờ')) {
                    currentStatus.className = 'ota-status active success';
                    currentStatus.textContent = `✅ Cập nhật có thể đã hoàn thành (không nhận được xác nhận). Vui lòng kiểm tra thiết bị.`;
                    showAlert('Cập nhật có thể đã hoàn thành. Vui lòng kiểm tra thiết bị.', 'info');
                }
            }, 60000); // 60 seconds timeout
        } else {
            throw new Error(result.error || 'Unknown error');
        }
    } catch (error) {
        if (statusDiv) {
            statusDiv.className = 'ota-status active error';
            statusDiv.textContent = `Lỗi: ${error.message}`;
        }
        showAlert('Lỗi gửi lệnh OTA', 'error');
    }
}

// Expose to global scope
window.startOTAUpdate = startOTAUpdate;

function showAlert(message, type = 'info') {
    const container = document.getElementById('alertContainer');
    const alert = document.createElement('div');
    alert.className = `alert ${type}`;
    alert.textContent = message;
    
    container.appendChild(alert);
    
    setTimeout(() => {
        alert.style.animation = 'slideIn 0.3s reverse';
        setTimeout(() => alert.remove(), 300);
    }, 3000);
}

window.logout = function () {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = './auth.html';
};

// Handle file selection
function handleFileSelect(event) {
    console.log('handleFileSelect called', event);
    const fileInput = event.target || document.getElementById('firmwareFile');
    console.log('fileInput:', fileInput);
    console.log('files:', fileInput?.files);
    
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        console.log('No file selected');
        return;
    }
    
    const fileName = fileInput.files[0].name;
    console.log('Selected file:', fileName);
    
    const fileNameSpan = document.getElementById('fileName');
    console.log('fileNameSpan:', fileNameSpan);
    
    if (fileNameSpan) {
        fileNameSpan.textContent = fileName;
        console.log('File name updated to:', fileName);
    } else {
        console.error('fileNameSpan element not found!');
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initWebSocket();
    loadFirmwareList();
    
    // Also setup file input listener as backup
    const fileInput = document.getElementById('firmwareFile');
    if (fileInput) {
        fileInput.addEventListener('change', function(e) {
            console.log('File input change event (backup handler)');
            handleFileSelect(e);
        });
    }
});

