/* =========================================================================
   driverless-mouse — hid-controller.js
   Motor de controle WebHID para a fase final do projeto.
   ========================================================================= */

const HIDPP_SHORT_REPORT_ID = 0x10;
const HIDPP_LONG_REPORT_ID = 0x11;
const HIDPP_SOFTWARE_ID = 0x01;

function buildHidppShortPacket(deviceIndex, subId, regAddress, params) {
  // HID++ RAP short report:
  // deviceIndex, subId, regAddress, params[0..2]
  const p = [0, 0, 0];
  (params || []).forEach((v, i) => {
    if (i < 3) p[i] = v & 0xff;
  });

  return new Uint8Array([
    deviceIndex & 0xff,
    subId & 0xff,
    regAddress & 0xff,
    ...p,
  ]);
}

function buildHidppLongPacket(deviceIndex, featureIndex, functionId, params) {
  // HID++ FAP long report:
  // deviceIndex + featureIndex + function/softwareId + 16 params.
  const p = new Array(16).fill(0);
  (params || []).forEach((v, i) => {
    if (i < p.length) p[i] = v & 0xff;
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

  // Fallbacks: usados somente se a descoberta dinâmica falhar.
  fallbackBatteryFeatureIndex: 0x06,
  fallbackAdjustableDpiFeatureIndex: 0x07,

  // Mantidos para compatibilidade com o restante do profile.
  batteryFeatureIndex: 0x06,
  adjustableDpiFeatureIndex: 0x07,

  currentSensorIndex: 0x00,

  // Este índice já fazia parte do projeto original.
  // Não é alterado nesta correção porque o objetivo aqui é
  // resolver dinamicamente 0x1004 e 0x2201.
  dpiEventFeatureIndex: 0x09,

  dpiStageCount: 5,
  batteryPollIntervalMs: 30000,

  connectionType(productId) {
    return this.productIds[productId] || "Sem fio";
  },

  resolveDeviceIndex(productId) {
    // G502 X através do receiver C547:
    // o mouse pareado está no Device Index 0x01.
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
    const retries = Math.max(1, options.retries ?? 3);
    const timeoutMs = Math.max(100, options.timeoutMs ?? 500);

    const featureHi = (featureId >> 8) & 0xff;
    const featureLo = featureId & 0xff;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response =
          await controller._sendHidppLongAndWait(
            0x00, // Feature Root
            0x00, // Root.GetFeature
            [featureHi, featureLo],
            `GetFeature 0x${featureId
              .toString(16)
              .padStart(4, "0")}`,
            (reportId, bytes) => {
              // FAP 2.0 usa exclusivamente o Long Report 0x11.
              if (reportId !== HIDPP_LONG_REPORT_ID) {
                return false;
              }

              // WebHID entrega event.data sem o Report ID.
              // bytes[0] = Device Index
              // bytes[1] = Feature Index
              // bytes[2] = Function/Software ID
              // bytes[3..] = parâmetros
              if (!bytes || bytes.length < 5) {
                return false;
              }

              if (bytes[0] !== controller.deviceIndex) {
                return false;
              }

              // FAP protocol error response:
              // featureIndex=0xff, params[0] = requested
              // function/software byte, params[1] = error code.
              if (
                bytes[1] === 0xff &&
                bytes.length >= 5 &&
                bytes[3] === 0x01
              ) {
                throw new Error(
                  `HID++ 2.0 GetFeature 0x${featureId
                    .toString(16)
                    .padStart(4, "0")} retornou erro 0x${bytes[4]
                    .toString(16)
                    .padStart(2, "0")}.`
                );
              }

              // Root.
              if (bytes[1] !== 0x00) {
                return false;
              }

              // GetFeature.
              if (((bytes[2] >> 4) & 0x0f) !== 0x00) {
                return false;
              }

              // Nosso Software ID.
              if ((bytes[2] & 0x0f) !== HIDPP_SOFTWARE_ID) {
                return false;
              }

              return true;
            },
            timeoutMs
          );

        const bytes = response.bytes;

        // Para Root.GetFeature:
        // params[0] = Feature Index alocado.
        // params[1] = Feature Type.
        const resolvedIndex = bytes[3];
        const featureType = bytes[4];

        if (
          resolvedIndex === undefined ||
          resolvedIndex === 0x00 ||
          resolvedIndex === 0xff
        ) {
          throw new Error(
            `Feature 0x${featureId
              .toString(16)
              .padStart(4, "0")} não encontrada (index 0x${(
              resolvedIndex ?? 0
            )
              .toString(16)
              .padStart(2, "0")}).`
          );
        }

        return {
          featureId,
          featureIndex: resolvedIndex,
          featureType,
          reportId: response.reportId,
          attempt,
        };
      } catch (err) {
        if (attempt >= retries) {
          throw err;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, 60 * attempt)
        );
      }
    }

    return null;
  },

  async resolveFeatures(controller) {
    controller.logitechFeatures = {
      unifiedBattery: null,
      adjustableDpi: null,
    };

    const isDongle =
      controller.device?.productId === 0xc547;

    // Cabo: mantém o comportamento conhecido do projeto.
    if (!isDongle) {
      controller.logitechFeatures.unifiedBattery =
        this.batteryFeatureIndex;

      controller.logitechFeatures.adjustableDpi =
        this.adjustableDpiFeatureIndex;

      return controller.logitechFeatures;
    }

    // No receiver C547, os Feature Indexes são runtime.
    try {
      const battery = await this.resolveFeature(
        controller,
        0x1004,
        {
          retries: 3,
          timeoutMs: 500,
        }
      );

      controller.logitechFeatures.unifiedBattery =
        battery.featureIndex;

      console.info(
        `[G502 X] Unified Battery 0x1004 -> feature index 0x${battery.featureIndex
          .toString(16)
          .padStart(2, "0")}`
      );
    } catch (err) {
      const fallback =
        this.getFallbackFeatureIndex(0x1004);

      controller.logitechFeatures.unifiedBattery =
        fallback;

      console.warn(
        `[G502 X] GetFeature 0x1004 falhou; usando fallback 0x${fallback
          .toString(16)
          .padStart(2, "0")}.`,
        err
      );
    }

    // Não sobreponha duas transações FAP no receiver.
    await new Promise((resolve) =>
      setTimeout(resolve, 60)
    );

    try {
      const dpi = await this.resolveFeature(
        controller,
        0x2201,
        {
          retries: 3,
          timeoutMs: 500,
        }
      );

      controller.logitechFeatures.adjustableDpi =
        dpi.featureIndex;

      console.info(
        `[G502 X] Adjustable DPI 0x2201 -> feature index 0x${dpi.featureIndex
          .toString(16)
          .padStart(2, "0")}`
      );
    } catch (err) {
      const fallback =
        this.getFallbackFeatureIndex(0x2201);

      controller.logitechFeatures.adjustableDpi =
        fallback;

      console.warn(
        `[G502 X] GetFeature 0x2201 falhou; usando fallback 0x${fallback
          .toString(16)
          .padStart(2, "0")}.`,
        err
      );
    }

    // Compatibilidade com código existente.
    this.batteryFeatureIndex =
      controller.logitechFeatures.unifiedBattery;

    this.adjustableDpiFeatureIndex =
      controller.logitechFeatures.adjustableDpi;

    return controller.logitechFeatures;
  },

  async init(controller) {
    controller.deviceIndex =
      this.resolveDeviceIndex(
        controller.device.productId
      );

    controller.logitechFeatures = {
      unifiedBattery: null,
      adjustableDpi: null,
    };

    try {
      // Descobre os índices antes de consultar bateria/DPI.
      await this.resolveFeatures(controller);

      // Ping é RAP, portanto continua sendo Short Report 0x10.
      await controller._logitechPing();

      await new Promise((resolve) =>
        setTimeout(resolve, 100)
      );

      if (
        controller.logitechFeatures.unifiedBattery !== null
      ) {
        await controller._logitechRequestBattery();
        controller._startLogitechBatteryPolling();
      }

      if (
        controller.logitechFeatures.adjustableDpi !== null
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, 100)
        );

        await this.getDpi(controller);
      }
    } catch (err) {
      console.warn(
        "[driverless-mouse] Aviso na inicialização Logitech:",
        err
      );
    }
  },

  async getDpi(controller) {
    const featureIndex =
      controller.logitechFeatures?.adjustableDpi ??
      this.adjustableDpiFeatureIndex;

    if (
      featureIndex === null ||
      featureIndex === undefined
    ) {
      return false;
    }

    return controller._sendHidppLong(
      featureIndex,
      0x02,
      [this.currentSensorIndex],
      "GetSensorDPI",
      true
    );
  },

  async setDpi(controller, dpiValue) {
    const featureIndex =
      controller.logitechFeatures?.adjustableDpi ??
      this.adjustableDpiFeatureIndex;

    if (
      featureIndex === null ||
      featureIndex === undefined
    ) {
      return false;
    }

    const clamped = Math.max(
      100,
      Math.min(32000, Math.round(dpiValue))
    );

    const high = (clamped >> 8) & 0xff;
    const low = clamped & 0xff;

    const ok = await controller._sendHidppLong(
      featureIndex,
      0x03,
      [this.currentSensorIndex, high, low],
      `SetSensorDPI (${clamped})`,
      false
    );

    if (ok) {
      await new Promise((resolve) =>
        setTimeout(resolve, 250)
      );

      await this.getDpi(controller);
    }

    return ok;
  },

  handleInputReport(controller, reportId, bytes) {
    if (!bytes || bytes.length < 3) {
      return;
    }

    const deviceIndexOk =
      this.knownDeviceIndexes.includes(bytes[0]);

    if (!deviceIndexOk) {
      return;
    }

    // HID++ 2.0 error response:
    // feature index 0xff, params[0] = function,
    // params[1] = error code.
    if (
      reportId === HIDPP_LONG_REPORT_ID &&
      bytes[1] === 0xff &&
      bytes.length >= 5
    ) {
      console.warn(
        `[HID++ 2.0] Erro: feature 0x${bytes[2]
          .toString(16)
          .padStart(2, "0")}, função 0x${(
          bytes[3] >> 4
        )
          .toString(16)
          .padStart(1, "0")}, código 0x${bytes[4]
          ?.toString(16)
          .padStart(2, "0") ?? "??"}`
      );
      return;
    }

    const dpiFeatureIndex =
      controller.logitechFeatures?.adjustableDpi ??
      this.adjustableDpiFeatureIndex;

    if (
      reportId === HIDPP_LONG_REPORT_ID &&
      dpiFeatureIndex !== null &&
      dpiFeatureIndex !== undefined &&
      bytes[1] === dpiFeatureIndex &&
      bytes.length >= 6
    ) {
      const func = bytes[2] >> 4;

      if (func === 0x02 || func === 0x03) {
        this.currentSensorIndex = bytes[3];

        const dpiValue =
          (bytes[4] << 8) | bytes[5];

        if (dpiValue > 0) {
          controller._emitDpiValue(dpiValue);
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

      if (
        stage >= 0 &&
        stage < this.dpiStageCount
      ) {
        controller._emitDpiStage(stage);
        this.getDpi(controller);
        return;
      }
    }

    const batteryFeatureIndex =
      controller.logitechFeatures?.unifiedBattery ??
      this.batteryFeatureIndex;

    if (
      reportId === HIDPP_LONG_REPORT_ID &&
      batteryFeatureIndex !== null &&
      batteryFeatureIndex !== undefined &&
      bytes[1] === batteryFeatureIndex &&
      bytes.length >= 5
    ) {
      const func = bytes[2] >> 4;

      if (func === 0x01) {
        const percentage = bytes[3];
        const chargingStatus = bytes[4];
        const isCharging =
          chargingStatus === 1 ||
          chargingStatus === 2;

        if (
          percentage >= 0 &&
          percentage <= 100
        ) {
          controller._emitBattery(
            percentage,
            isCharging
          );
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

    this.logitechFeatures = {
      unifiedBattery: null,
      adjustableDpi: null,
    };

    // Transações FAP são serializadas para o receiver.
    this._hidppQueue = Promise.resolve();
    this._hidppWaiters = new Set();

    this._boundInputReport = (event) =>
      this._handleInputReport(event);

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

      device.addEventListener(
        "inputreport",
        this._boundInputReport
      );

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
    this._rejectAllHidppWaiters(
      new Error("Dispositivo desconectado.")
    );

    if (this.device) {
      try {
        this.device.removeEventListener(
          "inputreport",
          this._boundInputReport
        );
      } catch (_) {}

      try {
        await this.device.close();
      } catch (_) {}
    }

    this.device = null;
    this.profile = null;
    this.deviceIndex = 0xff;

    this.logitechFeatures = {
      unifiedBattery: null,
      adjustableDpi: null,
    };

    if (typeof this.onDisconnect === "function") {
      this.onDisconnect();
    }
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
              err.name === "InvalidStateError" ? "O dispositivo já está aberto por outra aba/processo." :
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
    const data = event.data;

    const bytes = Array.from(
      new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength
      )
    );

    // Primeiro resolve a transação que está esperando a resposta.
    // Depois encaminha para o profile para atualizar a UI.
    this._dispatchHidppWaiters(
      event.reportId,
      bytes
    );

    if (!this.profile) return;

    if (this.profile.id === "logitech-g502x") {
      this.profile.handleInputReport(
        this,
        event.reportId,
        bytes
      );
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

  _waitForHidppResponse(matcher, timeoutMs = 500) {
    return new Promise((resolve, reject) => {
      const waiter = {
        matcher,
        done: false,
        timer: null,
        resolve: (value) => {
          if (waiter.done) return;
          waiter.done = true;

          if (waiter.timer) {
            clearTimeout(waiter.timer);
          }

          this._hidppWaiters.delete(waiter);
          resolve(value);
        },
        reject: (err) => {
          if (waiter.done) return;
          waiter.done = true;

          if (waiter.timer) {
            clearTimeout(waiter.timer);
          }

          this._hidppWaiters.delete(waiter);
          reject(err);
        },
      };

      waiter.timer = setTimeout(() => {
        waiter.reject(
          new Error(
            `Timeout aguardando resposta HID++ (${timeoutMs} ms).`
          )
        );
      }, timeoutMs);

      this._hidppWaiters.add(waiter);
    });
  }

  _dispatchHidppWaiters(reportId, bytes) {
    for (
      const waiter of Array.from(this._hidppWaiters)
    ) {
      let matched = false;

      try {
        matched =
          waiter.matcher(reportId, bytes) === true;
      } catch (err) {
        waiter.reject(err);
        return true;
      }

      if (matched) {
        waiter.resolve({
          reportId,
          bytes: Array.from(bytes),
        });

        return true;
      }
    }

    return false;
  }

  _rejectAllHidppWaiters(err) {
    for (
      const waiter of Array.from(
        this._hidppWaiters
      )
    ) {
      waiter.reject(err);
    }

    this._hidppWaiters.clear();
  }

  _enqueueHidppTransaction(task) {
    const run = this._hidppQueue.then(
      () => task()
    );

    // A fila não pode ficar "contaminada" por uma rejeição.
    this._hidppQueue = run.catch(() => undefined);

    return run;
  }

  async _sendHidppShort(
    subId,
    regAddress,
    params,
    label,
    silentFail = false
  ) {
    if (!this.device) {
      return false;
    }

    const data = buildHidppShortPacket(
      this.deviceIndex,
      subId,
      regAddress,
      params
    );

    try {
      await this.device.sendReport(
        HIDPP_SHORT_REPORT_ID,
        data
      );

      return true;
    } catch (err) {
      if (!silentFail) {
        this._error(
          `Falha ao enviar "${label}": ${
            err?.message || err
          }`
        );
      }

      return false;
    }
  }

  async _sendHidppLong(
    featureIndex,
    functionId,
    params,
    label,
    silentFail = false
  ) {
    if (!this.device) {
      return false;
    }

    const data = buildHidppLongPacket(
      this.deviceIndex,
      featureIndex,
      functionId,
      params
    );

    try {
      await this.device.sendReport(
        HIDPP_LONG_REPORT_ID,
        data
      );

      return true;
    } catch (err) {
      if (!silentFail) {
        this._error(
          `Falha ao enviar "${label}": ${
            err?.message || err
          }`
        );
      }

      return false;
    }
  }

  async _sendHidppLongAndWait(
    featureIndex,
    functionId,
    params,
    label,
    matcher,
    timeoutMs = 500
  ) {
    return this._enqueueHidppTransaction(
      async () => {
        if (!this.device) {
          throw new Error(
            `Dispositivo ausente ao enviar "${label}".`
          );
        }

        // O waiter é registrado ANTES do sendReport.
        const responsePromise =
          this._waitForHidppResponse(
            matcher,
            timeoutMs
          );

        const data = buildHidppLongPacket(
          this.deviceIndex,
          featureIndex,
          functionId,
          params
        );

        try {
          await this.device.sendReport(
            HIDPP_LONG_REPORT_ID,
            data
          );
        } catch (err) {
          // Não existe resposta esperável se o transporte falhou.
          // Rejeita o waiter específico.
          for (
            const waiter of Array.from(
              this._hidppWaiters
            )
          ) {
            if (!waiter.done) {
              waiter.reject(err);
              break;
            }
          }

          throw new Error(
            `Falha ao enviar "${label}": ${
              err?.message || err
            }`
          );
        }

        return responsePromise;
      }
    );
  }

  async _logitechPing() {
    // GetProtocolVersion é RAP, não FAP.
    // Portanto usa Short Report 0x10:
    // deviceIndex, subId=0x00, regAddress=0x10,
    // params = 00 00 5a.
    await this._sendHidppShort(
      0x00,
      0x10,
      [0x00, 0x00, 0x5a],
      "Ping (GetProtocolVersion)",
      true
    );
  }

  async _logitechRequestBattery() {
    const featureIndex =
      this.logitechFeatures?.unifiedBattery ??
      this.profile?.batteryFeatureIndex;

    if (
      featureIndex === null ||
      featureIndex === undefined
    ) {
      return;
    }

    // 0x1004 é FAP -> Long Report 0x11.
    await this._sendHidppLong(
      featureIndex,
      0x01,
      [],
      "GetStatus (Unified Battery)",
      true
    );
  }

  _stopLogitechBatteryPolling() {
    if (this._batteryTimer) {
      clearInterval(this._batteryTimer);
      this._batteryTimer = null;
    }
  }
}

export { DEVICE_PROFILES, ATTACK_SHARK_V3, LOGITECH_G502X };