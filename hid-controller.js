/* =========================================================================
   driverless-mouse — hid-controller.js
   Motor de controle WebHID para a fase final do projeto.
   ========================================================================= */

const HIDPP_SHORT_REPORT_ID = 0x10;
const HIDPP_LONG_REPORT_ID = 0x11;
const HIDPP_SOFTWARE_ID = 0x01;

function buildHidppShortPacket(deviceIndex, featureIndex, functionId, params) {
  const p = [0, 0, 0];
  (params || []).forEach((v, i) => { if (i < 3) p[i] = v & 0xff; });
  const funcByte = ((functionId & 0x0f) << 4) | (HIDPP_SOFTWARE_ID & 0x0f);
  return new Uint8Array([deviceIndex & 0xff, featureIndex & 0xff, funcByte, ...p]);
}

const ATTACK_SHARK_V3 = {
  id: "attack-shark-v3",
  label: "Attack Shark V3",
  vendorId: 0x1d57,
  productIds: {
    0xfa60: "Dongle 2.4GHz",
    0x215a: "Cabo USB",
  },
  dpiReportId: null,   
  dpiByteOffset: null, 
  pollIntervalMs: 400, 

  connectionType(productId) {
    return this.productIds[productId] || "Desconhecido";
  },

  async init(controller) {
    controller._startAttackSharkPolling();
  },

  async pollStep(controller, reportId) {
    try {
      const view = await controller.device.receiveFeatureReport(reportId);
      const bytes = Array.from(new Uint8Array(view.buffer));
      controller._handleAttackSharkFeatureReport(reportId, bytes);
    } catch (_err) {}
  },

  parseDpiStage(bytes) {
    if (this.dpiByteOffset === null || bytes.length <= this.dpiByteOffset) return null;
    return bytes[this.dpiByteOffset];
  },
};

const LOGITECH_G502X = {
  id: "logitech-g502x",
  label: "Logitech G502 X LIGHTSPEED",
  vendorId: 0x046d,
  productIds: {
    0xc098: "Cabo USB",
    0xc547: "Sem fio / Dongle LIGHTSPEED",
  },
  knownDeviceIndexes: [0xff, 0x01],
  
  batteryFeatureIndex: null,
  adjustableDpiFeatureIndex: null, 
  currentSensorIndex: 0x00, 
  
  dpiEventFeatureIndex: 0x09,     
  dpiStageCount: 5,
  batteryPollIntervalMs: 30000, 

  connectionType(productId) {
    return this.productIds[productId] || "Sem fio";
  },

  resolveDeviceIndex(productId) {
    return productId === 0xc547 ? 0x01 : 0xff;
  },

  async resolveFeature(controller, featureId) {
    return new Promise((resolve) => {
      let timeout;

      const listener = (event) => {
        const bytes = Array.from(new Uint8Array(event.data.buffer));
        if (bytes[0] === controller.deviceIndex && bytes[1] === 0x00 && (bytes[2] >> 4) === 0x00) {
          const featureIndex = bytes[3];
          clearTimeout(timeout);
          controller.device.removeEventListener("inputreport", listener);
          resolve(featureIndex !== 0 ? featureIndex : null);
        }
      };

      controller.device.addEventListener("inputreport", listener);

      timeout = setTimeout(() => {
        controller.device.removeEventListener("inputreport", listener);
        resolve(null);
      }, 1000);

      const high = (featureId >> 8) & 0xff;
      const low = featureId & 0xff;
      controller._sendHidppShort(0x00, 0x00, [high, low, 0x00], `GetFeature(0x${featureId.toString(16).padStart(4, '0')})`);
    });
  },

  async init(controller) {
    controller.deviceIndex = this.resolveDeviceIndex(controller.device.productId);
    
    await controller._logitechPing();
    await new Promise((r) => setTimeout(r, 200));

    // Tenta resolução dinâmica. Se falhar (como no modo cabo), usa os fallbacks fixos (0x07 e 0x06)
    if (controller.device.productId === 0xc098) {
      // Modo Cabo: Usa os índices padrão de fábrica mapeados no diagnóstico
      this.adjustableDpiFeatureIndex = 0x07;
      this.batteryFeatureIndex = 0x06;
    } else {
      // Modo Dongle: Resolve dinamicamente
      this.adjustableDpiFeatureIndex = await this.resolveFeature(controller, 0x2201) || 0x07;
      this.batteryFeatureIndex = await this.resolveFeature(controller, 0x1004) || 0x06;
    }

    if (this.batteryFeatureIndex !== null) {
      await controller._logitechRequestBattery(); 
      controller._startLogitechBatteryPolling();
    }
    
    if (this.adjustableDpiFeatureIndex !== null) {
      await new Promise((r) => setTimeout(r, 150));
      await this.getDpi(controller); 
    }
  },

  async getDpi(controller) {
    if (this.adjustableDpiFeatureIndex === null) return;
    await controller._sendHidppShort(
      this.adjustableDpiFeatureIndex,
      0x02, 
      [0x00, 0x00, 0x00], 
      "GetSensorDPI"
    );
  },

  async setDpi(controller, dpiValue) {
    if (this.adjustableDpiFeatureIndex === null) return false;
    
    const clamped = Math.max(100, Math.min(32000, dpiValue));
    const high = (clamped >> 8) & 0xff;
    const low = clamped & 0xff;
    
    const ok = await controller._sendHidppShort(
      this.adjustableDpiFeatureIndex,
      0x03,
      [this.currentSensorIndex, high, low],
      `SetSensorDPI (${clamped})`
    );
    
    if (ok) {
      await new Promise((r) => setTimeout(r, 250));
      await this.getDpi(controller);
    }
    return ok;
  },

  handleInputReport(controller, reportId, bytes) {
    const deviceIndexOk = this.knownDeviceIndexes.includes(bytes[0]);

    if (deviceIndexOk && bytes[1] === 0x8f) {
      console.warn(`[HID++ Erro do Firmware] Feature: 0x${bytes[2].toString(16)}, Código de Erro: 0x${bytes[3].toString(16)}`);
    }

    if (deviceIndexOk && this.adjustableDpiFeatureIndex !== null && bytes[1] === this.adjustableDpiFeatureIndex && bytes.length > 5) {
      const func = bytes[2] >> 4;
      if (func === 0x02 || func === 0x03) {
        this.currentSensorIndex = bytes[3]; 
        const dpiValue = (bytes[4] << 8) | bytes[5];
        if (dpiValue > 0) {
          controller._emitDpiValue(dpiValue);
          return;
        }
      }
    }

    if (deviceIndexOk && reportId === HIDPP_LONG_REPORT_ID && bytes[1] === this.dpiEventFeatureIndex && bytes.length > 3) {
      const stage = bytes[3];
      if (stage >= 0 && stage < this.dpiStageCount) {
        controller._emitDpiStage(stage);
        this.getDpi(controller); 
        return;
      }
    }

    if (deviceIndexOk && this.batteryFeatureIndex !== null && (reportId === HIDPP_SHORT_REPORT_ID || reportId === HIDPP_LONG_REPORT_ID) && bytes[1] === this.batteryFeatureIndex) {
      const func = bytes[2] >> 4;
      if (func === 0x01) { 
        const percentage = bytes[3]; 
        const chargingStatus = bytes[4]; 
        const isCharging = chargingStatus === 1 || chargingStatus === 2;
        
        if (percentage >= 0 && percentage <= 100) {
          controller._emitBattery(percentage, isCharging);
        }
      }
    }
  },
};

const DEVICE_PROFILES = [ATTACK_SHARK_V3, LOGITECH_G502X];

export class MouseController {
  constructor() {
    this.device = null;
    this.profile = null;
    this._pollTimer = null;
    this._batteryTimer = null;
    this._attackSharkReportCursor = 0x01;
    this.deviceIndex = 0xff; 
    this.onConnect = null;        
    this.onDisconnect = null;     
    this.onDpiStageChange = null; 
    this.onDpiValueChange = null; 
    this.onBatteryUpdate = null;  
    this.onError = null;          
  }

  static isSupported() {
    return "hid" in navigator;
  }

  async setDpi(dpiValue) {
    if (!this.device || !this.profile) {
      this._error("Conecte um mouse primeiro.");
      return false;
    }
    if (typeof this.profile.setDpi !== "function") {
      this._error(`Alterar DPI ainda não é suportado para o perfil "${this.profile.label}".`);
      return false;
    }
    if (!Number.isFinite(dpiValue) || dpiValue <= 0) {
      this._error("Valor de DPI inválido.");
      return false;
    }
    return this.profile.setDpi(this, Math.round(dpiValue));
  }

  async connect() {
    if (!MouseController.isSupported()) {
      this._error("Este navegador não suporta WebHID. Use Chrome ou Edge atualizado.");
      return false;
    }

    try {
      const filters = DEVICE_PROFILES.map((p) => ({ vendorId: p.vendorId }));
      const [device] = await navigator.hid.requestDevice({ filters });
      if (!device) return false;

      await device.open();
      this.device = device;
      this.profile = this._matchProfile(device);

      device.addEventListener("inputreport", (event) => this._handleInputReport(event));

      if (!this.profile) {
        this._error(`Dispositivo conectado, mas não reconhecido.`);
        return true; 
      }

      if (typeof this.onConnect === "function") {
        this.onConnect({
          name: device.productName || this.profile.label,
          vid: device.vendorId,
          pid: device.productId,
          connectionType: this.profile.connectionType(device.productId),
          profileId: this.profile.id,
        });
      }

      await this.profile.init(this);
      return true;
    } catch (err) {
      this._handleConnectionError(err);
      return false;
    }
  }

  async disconnect() {
    this._stopAttackSharkPolling();
    this._stopLogitechBatteryPolling();
    if (this.device) {
      try { await this.device.close(); } catch (_) {}
    }
    this.device = null;
    this.profile = null;
    if (typeof this.onDisconnect === "function") this.onDisconnect();
  }

  _matchProfile(device) {
    return (
      DEVICE_PROFILES.find(
        (p) => p.vendorId === device.vendorId && device.productId in p.productIds
      ) ?? null
    );
  }

  _handleConnectionError(err) {
    let msg = err.name === "NotFoundError" ? "Nenhum mouse foi selecionado." :
              err.name === "SecurityError" ? "Acesso HID bloqueado pelo navegador." :
              err.name === "InvalidStateError" ? "O dispositivo já está aberto por outra aba/processo. Feche o GHUB!" :
              `Erro ao conectar: ${err.message}`;
    this._error(msg);
  }

  _error(message) {
    if (typeof this.onError === "function") this.onError(message);
    else console.warn("[driverless-mouse]", message);
  }

  _emitDpiStage(stage) {
    if (typeof this.onDpiStageChange === "function") this.onDpiStageChange(stage);
  }

  _emitDpiValue(dpiValue) {
    if (typeof this.onDpiValueChange === "function") this.onDpiValueChange(dpiValue);
  }

  _emitBattery(percentage, isCharging) {
    if (typeof this.onBatteryUpdate === "function") this.onBatteryUpdate(percentage, isCharging);
  }

  _handleInputReport(event) {
    if (!this.profile) return;
    const bytes = Array.from(new Uint8Array(event.data.buffer));

    if (this.profile.id === "logitech-g502x") {
      this.profile.handleInputReport(this, event.reportId, bytes);
    }
  }

  _startAttackSharkPolling() {
    this._stopAttackSharkPolling();
    this._attackSharkReportCursor = 0x01;

    this._pollTimer = setInterval(async () => {
      if (!this.device || !this.profile) return;
      const reportId = this._attackSharkReportCursor;
      await this.profile.pollStep(this, reportId);
      this._attackSharkReportCursor += 1;
      if (this._attackSharkReportCursor > 0x20) this._attackSharkReportCursor = 0x01;
    }, this.profile.pollIntervalMs);
  }

  _stopAttackSharkPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _handleAttackSharkFeatureReport(reportId, bytes) {
    if (this.profile.dpiReportId === null || reportId !== this.profile.dpiReportId) return;
    const stage = this.profile.parseDpiStage(bytes);
    if (stage !== null) this._emitDpiStage(stage);
  }

  async _sendHidppShort(featureIndex, functionId, params, label) {
    if (!this.device) return false;
    const data = buildHidppShortPacket(this.deviceIndex, featureIndex, functionId, params);
    try {
      await this.device.sendReport(HIDPP_SHORT_REPORT_ID, data);
      return true;
    } catch (err) {
      this._error(`Falha ao enviar "${label}". Feche o Logitech G HUB.`);
      return false;
    }
  }

  async _logitechPing() {
    await this._sendHidppShort(0x00, 0x01, [0x00, 0x00, 0x5a], "Ping (GetProtocolVersion)");
  }

  async _logitechRequestBattery() {
    if (this.profile.batteryFeatureIndex === null) return;
    await this._sendHidppShort(
      this.profile.batteryFeatureIndex,
      0x01, 
      [0x00, 0x00, 0x00],
      "GetStatus (Unified Battery)"
    );
  }

  _startLogitechBatteryPolling() {
    this._stopLogitechBatteryPolling();
    this._batteryTimer = setInterval(() => {
      if (!this.device) return;
      this._logitechRequestBattery();
    }, this.profile.batteryPollIntervalMs);
  }

  _stopLogitechBatteryPolling() {
    if (this._batteryTimer) {
      clearInterval(this._batteryTimer);
      this._batteryTimer = null;
    }
  }
}

export { DEVICE_PROFILES, ATTACK_SHARK_V3, LOGITECH_G502X };