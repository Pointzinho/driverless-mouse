/* =========================================================================
   driverless-mouse — hid-controller.js
   Motor de controle WebHID corrigido e estabilizado para o Logitech G502 X.
   ========================================================================= */

const HIDPP_SHORT_REPORT_ID = 0x10;
const HIDPP_LONG_REPORT_ID = 0x11;
const HIDPP_SOFTWARE_ID = 0x01;

function buildHidppShortPacket(deviceIndex, featureIndex, functionId, params) {
  const p = [0, 0, 0];
  (params || []).forEach((v, i) => {
    if (i < 3) p[i] = v & 0xff;
  });

  const funcByte =
    ((functionId & 0x0f) << 4) |
    (HIDPP_SOFTWARE_ID & 0x0f);

  return new Uint8Array([
    deviceIndex & 0xff,
    featureIndex & 0xff,
    funcByte,
    ...p,
  ]);
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
      const bytes = Array.from(
        new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength
        )
      );

      controller._handleAttackSharkFeatureReport(reportId, bytes);
    } catch (_err) {}
  },

  parseDpiStage(bytes) {
    if (
      this.dpiByteOffset === null ||
      bytes.length <= this.dpiByteOffset
    ) {
      return null;
    }

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

  fallbackBatteryFeatureIndex: 0x06,
  fallbackAdjustableDpiFeatureIndex: 0x07,

  batteryFeatureIndex: 0x06,
  adjustableDpiFeatureIndex: 0x07,

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

  getFallbackFeatureIndex(featureId) {
    if (featureId === 0x1004) {
      return this.fallbackBatteryFeatureIndex;
    }
    if (featureId === 0x2201) {
      return this.fallbackAdjustableDpiFeatureIndex;
    }
    return null;
  },

  async resolveFeature(controller, featureId, options = {}) {
    const retries = Math.max(1, options.retries ?? 5);
    const timeoutMs = Math.max(300, options.timeoutMs ?? 1500);

    const featureHi = (featureId >> 8) & 0xff;
    const featureLo = featureId & 0xff;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.info(`[G502X] Resolvendo feature 0x${featureId.toString(16)} (tentativa ${attempt}/${retries})...`);
        const response =
          await controller._sendHidppShortAndWait(
            0x00, // Feature Root
            0x00, // GetFeature
            [featureHi, featureLo, 0x00],
            `GetFeature 0x${featureId.toString(16).padStart(4, "0")}`,
            (reportId, bytes) => {
              if (!bytes || bytes.length < 4) return false;
              if (bytes[0] !== controller.deviceIndex) return false;
              if (bytes[1] !== 0x00) return false; // Resposta da raiz
              const functionId = (bytes[2] >> 4) & 0x0f;
              if (functionId !== 0x00) return false; // GetFeature response
              return true;
            },
            timeoutMs
          );

        if (!response || !response.bytes) {
          throw new Error("Resposta HID++ vazia.");
        }

        const bytes = response.bytes;
        const resolvedIndex = bytes[3];
        console.info(`[G502X] Feature 0x${featureId.toString(16)} resolvida para index: 0x${resolvedIndex.toString(16)}`);

        if (
          resolvedIndex === undefined ||
          resolvedIndex === null ||
          resolvedIndex === 0x00 ||
          resolvedIndex === 0xff
        ) {
          throw new Error(`Feature 0x${featureId.toString(16).padStart(4, "0")} inválida.`);
        }

        return {
          featureId,
          featureIndex: resolvedIndex,
          reportId: response.reportId,
          attempt,
        };
      } catch (err) {
        console.warn(`[G502X] Tentativa ${attempt} falhou para feature 0x${featureId.toString(16)}:`, err.message);
        if (attempt >= retries) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
    return null;
  },

  async resolveFeatures(controller) {
    if (!controller.logitechFeatures) {
      controller.logitechFeatures = {
        unifiedBattery: null,
        adjustableDpi: null,
      };
    }

    const isDongle = controller.device?.productId === 0xc547;

    if (!isDongle) {
      controller.logitechFeatures.unifiedBattery = this.batteryFeatureIndex;
      controller.logitechFeatures.adjustableDpi = this.adjustableDpiFeatureIndex;
      return controller.logitechFeatures;
    }

    // 0x1004 — Unified Battery
    try {
      const result = await this.resolveFeature(controller, 0x1004, { retries: 3, timeoutMs: 1200 });
      controller.logitechFeatures.unifiedBattery = result.featureIndex;
    } catch (_err) {
      controller.logitechFeatures.unifiedBattery = this.getFallbackFeatureIndex(0x1004);
    }

    await new Promise((resolve) => setTimeout(resolve, 80));

    // 0x2201 — Adjustable DPI
    try {
      const result = await this.resolveFeature(controller, 0x2201, { retries: 3, timeoutMs: 1200 });
      controller.logitechFeatures.adjustableDpi = result.featureIndex;
    } catch (_err) {
      controller.logitechFeatures.adjustableDpi = this.getFallbackFeatureIndex(0x2201);
    }

    this.batteryFeatureIndex = controller.logitechFeatures.unifiedBattery;
    this.adjustableDpiFeatureIndex = controller.logitechFeatures.adjustableDpi;

    console.info("[G502X] Features finais resolvidas:", controller.logitechFeatures);
    return controller.logitechFeatures;
  },

  async init(controller) {
    controller.deviceIndex = this.resolveDeviceIndex(controller.device.productId);
    controller.logitechFeatures = { unifiedBattery: null, adjustableDpi: null };

    try {
      await this.resolveFeatures(controller);
      await controller._logitechPing();
      await new Promise((resolve) => setTimeout(resolve, 150));

      if (controller.logitechFeatures.unifiedBattery !== null) {
        await controller._logitechRequestBattery();
        controller._startLogitechBatteryPolling();
      }

      if (controller.logitechFeatures.adjustableDpi !== null) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await this.getDpi(controller);
      }
    } catch (err) {
      console.warn("[driverless-mouse] Aviso na inicialização Logitech:", err);
    }
  },

  async getDpi(controller) {
    const featureIndex =
      controller.logitechFeatures?.adjustableDpi ??
      this.adjustableDpiFeatureIndex;

    if (featureIndex === null || featureIndex === undefined) {
      return;
    }

    await controller._sendHidppShort(
      featureIndex,
      0x02,
      [0x00, 0x00, 0x00],
      "GetSensorDPI",
      true
    );
  },

  async setDpi(controller, dpiValue) {
    const featureIndex =
      controller.logitechFeatures?.adjustableDpi ??
      this.adjustableDpiFeatureIndex;

    if (featureIndex === null || featureIndex === undefined) {
      controller._error("Feature de DPI ajustável não encontrada.");
      return false;
    }

    const clamped = Math.max(100, Math.min(25600, dpiValue));
    const high = (clamped >> 8) & 0xff;
    const low = clamped & 0xff;

    try {
      const ok = await controller._sendHidppShort(
        featureIndex,
        0x03, // Função SetSensorDPI
        [this.currentSensorIndex, high, low],
        `SetSensorDPI (${clamped})`,
        false
      );

      if (!ok) {
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.getDpi(controller);
      return true;
    } catch (err) {
      controller._error(`Não foi possível aplicar ${clamped} DPI: ${err?.message || err}`);
      return false;
    }
  },

  handleInputReport(controller, reportId, bytes) {
    if (!bytes || bytes.length < 3) {
      return;
    }

    const deviceIndexOk = this.knownDeviceIndexes.includes(bytes[0]);
    if (!deviceIndexOk) {
      return;
    }

    if (bytes[1] === 0x8f && bytes.length >= 4) {
      console.warn(`[HID++ Erro do Firmware] Feature: 0x${bytes[2].toString(16)}, Erro: 0x${bytes[3].toString(16)}`);
    }

    const dpiFeatureIndex =
      controller.logitechFeatures?.adjustableDpi ??
      this.adjustableDpiFeatureIndex;

    if (
      dpiFeatureIndex !== null &&
      dpiFeatureIndex !== undefined &&
      bytes[1] === dpiFeatureIndex &&
      bytes.length > 5
    ) {
      const func = bytes[2] >> 4;
      if (func === 0x02 || func === 0x03) {
        this.currentSensorIndex = bytes[3];
        const dpiValue = (bytes[4] << 8) | bytes[5];
        if (dpiValue > 0) {
          const physicalStage = controller.logitechPhysicalStage;
          if (Number.isInteger(physicalStage) && physicalStage >= 0 && physicalStage < this.dpiStageCount) {
            controller.logitechDpiStages[physicalStage] = dpiValue;
          }
          controller._emitDpiValue(dpiValue, physicalStage);
          return;
        }
      }
    }

    if (
      reportId === HIDPP_LONG_REPORT_ID &&
      bytes[1] === this.dpiEventFeatureIndex &&
      bytes.length > 3
    ) {
      const stage = bytes[3];
      if (stage >= 0 && stage < this.dpiStageCount) {
        controller.logitechPhysicalStage = stage;
        controller._emitDpiStage(stage);
        this.getDpi(controller);
        return;
      }
    }

    const batteryFeatureIndex =
      controller.logitechFeatures?.unifiedBattery ??
      this.batteryFeatureIndex;

    if (
      batteryFeatureIndex !== null &&
      batteryFeatureIndex !== undefined &&
      (reportId === HIDPP_SHORT_REPORT_ID || reportId === HIDPP_LONG_REPORT_ID) &&
      bytes[1] === batteryFeatureIndex &&
      bytes.length >= 5
    ) {
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

const DEVICE_PROFILES = [
  ATTACK_SHARK_V3,
  LOGITECH_G502X,
];

export class MouseController {
  constructor() {
    this.device = null;
    this.profile = null;
    this._pollTimer = null;
    this._batteryTimer = null;
    this._attackSharkReportCursor = 0x01;
    this.deviceIndex = 0xff;
    this._hidppWaiters = new Set();

    this.logitechFeatures = {
      unifiedBattery: null,
      adjustableDpi: null,
    };

    this.logitechDpiStages = [800, 1200, 1600, 2400, 3200];
    this.logitechPhysicalStage = null;

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
      this._error(`Alterar DPI não é suportado para "${this.profile.label}".`);
      return false;
    }

    if (!Number.isFinite(dpiValue) || dpiValue <= 0) {
      this._error("Valor de DPI inválido.");
      return false;
    }

    const value = Math.round(dpiValue);
    return await this.profile.setDpi(this, value);
  }

  async connect() {
    if (!MouseController.isSupported()) {
      this._error("Este navegador não suporta WebHID.");
      return false;
    }

    try {
      const filters = DEVICE_PROFILES.map((p) => ({
        vendorId: p.vendorId,
      }));

      const [device] = await navigator.hid.requestDevice({ filters });
      if (!device) {
        return false;
      }

      await device.open();
      this.device = device;
      this.profile = this._matchProfile(device);

      device.addEventListener("inputreport", (event) => this._handleInputReport(event));

      if (!this.profile) {
        this._error("Dispositivo conectado, mas não reconhecido.");
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
    this._rejectAllHidppWaiters(new Error("Dispositivo desconectado."));

    if (this.device) {
      try {
        await this.device.close();
      } catch (_err) {}
    }

    this.device = null;
    this.profile = null;
    this.deviceIndex = 0xff;

    if (typeof this.onDisconnect === "function") {
      this.onDisconnect();
    }
  }

  _matchProfile(device) {
    return (
      DEVICE_PROFILES.find(
        (p) =>
          p.vendorId === device.vendorId &&
          device.productId in p.productIds
      ) ?? null
    );
  }

  _handleConnectionError(err) {
    const msg =
      err.name === "NotFoundError"
        ? "Nenhum mouse foi selecionado."
        : err.name === "SecurityError"
          ? "Acesso HID bloqueado pelo navegador."
          : err.name === "InvalidStateError"
            ? "O dispositivo já está aberto por outra aba."
            : `Erro ao conectar: ${err.message}`;
    this._error(msg);
  }

  _error(message) {
    if (typeof this.onError === "function") {
      this.onError(message);
    } else {
      console.warn("[driverless-mouse]", message);
    }
  }

  _emitDpiStage(stage) {
    if (typeof this.onDpiStageChange === "function") {
      this.onDpiStageChange(stage);
    }
  }

  _emitDpiValue(dpiValue, physicalStage = null) {
    if (typeof this.onDpiValueChange === "function") {
      this.onDpiValueChange(dpiValue, physicalStage);
    }
  }

  _emitBattery(percentage, isCharging) {
    if (typeof this.onBatteryUpdate === "function") {
      this.onBatteryUpdate(percentage, isCharging);
    }
  }

  _waitForHidppResponse(matcher, timeoutMs = 300) {
    return new Promise((resolve, reject) => {
      const waiter = {
        timer: null,
        done: false,
        matcher,
        resolve: (value) => {
          if (waiter.done) return;
          waiter.done = true;
          if (waiter.timer) clearTimeout(waiter.timer);
          this._hidppWaiters.delete(waiter);
          resolve(value);
        },
        reject: (err) => {
          if (waiter.done) return;
          waiter.done = true;
          if (waiter.timer) clearTimeout(waiter.timer);
          this._hidppWaiters.delete(waiter);
          reject(err);
        },
      };

      waiter.timer = setTimeout(() => {
        waiter.reject(new Error(`Timeout aguardando resposta HID++ (${timeoutMs} ms).`));
      }, timeoutMs);

      this._hidppWaiters.add(waiter);
    });
  }

  _dispatchHidppWaiters(reportId, bytes) {
    if (!bytes || bytes.length < 3) {
      return false;
    }
    const responseBytes = Array.from(bytes);
    for (const waiter of Array.from(this._hidppWaiters)) {
      let matched = false;
      try {
        matched = waiter.matcher(reportId, responseBytes) === true;
      } catch (_err) {
        matched = false;
      }
      if (matched) {
        waiter.resolve({ reportId, bytes: responseBytes });
        return true;
      }
    }
    return false;
  }

  _rejectAllHidppWaiters(err) {
    for (const waiter of Array.from(this._hidppWaiters)) {
      waiter.reject(err);
    }
    this._hidppWaiters.clear();
  }

  _handleInputReport(event) {
    const data = event.data;
    const bytes = Array.from(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );

    this._dispatchHidppWaiters(event.reportId, bytes);

    if (!this.profile) {
      return;
    }

    if (this.profile.id === "logitech-g502x") {
      this.profile.handleInputReport(this, event.reportId, bytes);
    }
  }

  async _sendHidppShortAndWait(featureIndex, functionId, params, label, matcher, timeoutMs = 300) {
    if (!this.device) {
      throw new Error(`Não é possível enviar "${label}": dispositivo ausente.`);
    }

    const responsePromise = this._waitForHidppResponse(matcher, timeoutMs);
    const data = buildHidppShortPacket(this.deviceIndex, featureIndex, functionId, params);

    try {
      await this.device.sendReport(HIDPP_SHORT_REPORT_ID, data);
    } catch (err) {
      throw new Error(`Falha ao enviar "${label}": ${err?.message || err}`);
    }

    return responsePromise;
  }

  async _sendHidppShort(featureIndex, functionId, params, label, silentFail = false) {
    if (!this.device) {
      return false;
    }

    const data = buildHidppShortPacket(this.deviceIndex, featureIndex, functionId, params);

    try {
      await this.device.sendReport(HIDPP_SHORT_REPORT_ID, data);
      return true;
    } catch (err) {
      if (!silentFail) {
        this._error(`Falha ao enviar "${label}": ${err.message}`);
      }
      return false;
    }
  }

  async _logitechPing() {
    await this._sendHidppShort(0x00, 0x01, [0x00, 0x00, 0x5a], "Ping", true);
  }

  async _logitechRequestBattery() {
    const featureIndex =
      this.logitechFeatures?.unifiedBattery ??
      this.profile?.batteryFeatureIndex;

    if (featureIndex === null || featureIndex === undefined) {
      return;
    }

    await this._sendHidppShort(featureIndex, 0x01, [0x00, 0x00, 0x00], "GetStatus", true);
  }

  _startLogitechBatteryPolling() {
    this._stopLogitechBatteryPolling();
    this._batteryTimer = setInterval(() => {
      if (!this.device) {
        return;
      }
      this._logitechRequestBattery();
    }, this.profile.batteryPollIntervalMs);
  }

  _stopLogitechBatteryPolling() {
    if (this._batteryTimer) {
      clearInterval(this._batteryTimer);
      this._batteryTimer = null;
    }
  }

  _startAttackSharkPolling() {
    this._stopAttackSharkPolling();
    this._attackSharkReportCursor = 0x01;
    this._pollTimer = setInterval(async () => {
      if (!this.device || !this.profile) {
        return;
      }
      const reportId = this._attackSharkReportCursor;
      await this.profile.pollStep(this, reportId);
      this._attackSharkReportCursor += 1;
      if (this._attackSharkReportCursor > 0x20) {
        this._attackSharkReportCursor = 0x01;
      }
    }, this.profile.pollIntervalMs);
  }

  _stopAttackSharkPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }
}

export {
  DEVICE_PROFILES,
  ATTACK_SHARK_V3,
  LOGITECH_G502X,
};