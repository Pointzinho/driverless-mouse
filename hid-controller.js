/* =========================================================================
   driverless-mouse — hid-controller.js
   Logitech G502 X LIGHTSPEED / LIGHTSPEED Receiver (PID 0xC547)

   IMPORTANT HID++ details:
   - HID++ RAP requests use Short Report 0x10.
   - HID++ FAP requests (ROOT / feature commands) are ALSO sent through
     the Logitech Short Report transport 0x10; the response is normally
     delivered as Long Report 0x11 through inputreport.
   - Logitech's software-id used by the HID++ 2.0 traces is 0x08.
   - C547 paired mouse uses Device Index 0x01.
   ========================================================================= */

const HIDPP_SHORT_REPORT_ID = 0x10;
const HIDPP_LONG_REPORT_ID = 0x11;

// Logitech HID++ software-id used by the FAP/RAP traces.
const HIDPP_SOFTWARE_ID = 0x08;

function buildHidppShortPacket(deviceIndex, featureIndex, functionId, params = []) {
  const p = [0x00, 0x00, 0x00];

  for (let i = 0; i < 3 && i < params.length; i++) {
    p[i] = params[i] & 0xff;
  }

  const functionByte =
    ((functionId & 0x0f) << 4) |
    (HIDPP_SOFTWARE_ID & 0x0f);

  return new Uint8Array([
    deviceIndex & 0xff,
    featureIndex & 0xff,
    functionByte,
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
      const view =
        await controller.device.receiveFeatureReport(reportId);

      const bytes = Array.from(
        new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength
        )
      );

      controller._handleAttackSharkFeatureReport(
        reportId,
        bytes
      );
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

  // Fallback only. On C547 we first resolve these through ROOT.GetFeature.
  fallbackBatteryFeatureIndex: 0x06,
  fallbackAdjustableDpiFeatureIndex: 0x07,

  // Compatibility fields used by the rest of the project.
  batteryFeatureIndex: 0x06,
  adjustableDpiFeatureIndex: 0x07,

  currentSensorIndex: 0x00,

  // Kept as a legacy notification candidate. We no longer depend on it
  // for the initial DPI read.
  dpiEventFeatureIndex: 0x09,

  dpiStageCount: 5,
  batteryPollIntervalMs: 30000,

  // Polling is deliberately modest. It gives us a reliable fallback for
  // DPI-stage changes even when the receiver does not emit a notification
  // report that WebHID exposes to this page.
  dpiPollIntervalMs: 500,

  connectionType(productId) {
    return this.productIds[productId] || "Sem fio";
  },

  resolveDeviceIndex(productId) {
    return productId === 0xc547 ? 0x01 : 0xff;
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

    // On the C547 the feature table is owned by the paired mouse and
    // must be resolved at runtime.
    await this.resolveFeatures(controller);

    // This is RAP and therefore stays on the Short Report 0x10.
    await controller._logitechPing();

    // Let the receiver settle before the first FAP transaction.
    await controller._sleep(120);

    await controller._logitechRequestBattery();
    await controller._sleep(60);

    await this.getDpi(controller);

    controller._startLogitechBatteryPolling();
    controller._startLogitechDpiPolling();
  },

  async resolveFeatures(controller) {
    const isC547 =
      controller.device?.productId === 0xc547;

    // Wired device: keep the existing known values.
    if (!isC547) {
      controller.logitechFeatures.unifiedBattery =
        this.batteryFeatureIndex;

      controller.logitechFeatures.adjustableDpi =
        this.adjustableDpiFeatureIndex;

      return controller.logitechFeatures;
    }

    // Discover one at a time. This avoids two ROOT requests racing on
    // the same receiver channel.
    const battery = await this._resolveFeatureWithFallback(
      controller,
      0x1004,
      this.fallbackBatteryFeatureIndex,
      "Unified Battery"
    );

    const dpi = await this._resolveFeatureWithFallback(
      controller,
      0x2201,
      this.fallbackAdjustableDpiFeatureIndex,
      "Adjustable DPI"
    );

    controller.logitechFeatures.unifiedBattery =
      battery;

    controller.logitechFeatures.adjustableDpi =
      dpi;

    // Keep legacy fields synchronized.
    this.batteryFeatureIndex = battery;
    this.adjustableDpiFeatureIndex = dpi;

    console.info(
      `[G502 X] C547 feature map: 0x1004 -> 0x${battery
        .toString(16)
        .padStart(2, "0")}, ` +
      `0x2201 -> 0x${dpi
        .toString(16)
        .padStart(2, "0")}`
    );

    return controller.logitechFeatures;
  },

  async _resolveFeatureWithFallback(
    controller,
    featureId,
    fallbackIndex,
    label
  ) {
    try {
      const result =
        await controller._resolveHidppFeature(
          featureId,
          {
            retries: 3,
            timeoutMs: 450,
          }
        );

      console.info(
        `[G502 X] ${label} 0x${featureId
          .toString(16)
          .padStart(4, "0")} -> index 0x${result
          .featureIndex
          .toString(16)
          .padStart(2, "0")}`
      );

      return result.featureIndex;
    } catch (err) {
      console.warn(
        `[G502 X] ROOT.GetFeature(${label}) falhou; ` +
        `usando fallback 0x${fallbackIndex
          .toString(16)
          .padStart(2, "0")}.`,
        err
      );

      return fallbackIndex;
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

    return controller._sendHidppShort(
      featureIndex,
      0x02,
      [this.currentSensorIndex, 0x00, 0x00],
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

    // Logitech documents the G502 X at 100..25600 DPI.
    const clamped = Math.max(
      100,
      Math.min(25600, Math.round(dpiValue))
    );

    const high = (clamped >> 8) & 0xff;
    const low = clamped & 0xff;

    const ok =
      await controller._sendHidppShort(
        featureIndex,
        0x03,
        [this.currentSensorIndex, high, low],
        `SetSensorDPI (${clamped})`,
        false
      );

    if (ok) {
      await controller._sleep(150);
      await this.getDpi(controller);
    }

    return ok;
  },

  handleInputReport(
    controller,
    reportId,
    bytes
  ) {
    if (!bytes || bytes.length < 3) {
      return;
    }

    if (
      !this.knownDeviceIndexes.includes(bytes[0])
    ) {
      return;
    }

    // HID++ error response.
    if (bytes[1] === 0x8f) {
      console.warn(
        `[HID++ ERROR] device=0x${bytes[0]
          .toString(16)
          .padStart(2, "0")} ` +
        `feature=0x${bytes[2]
          ?.toString(16)
          .padStart(2, "0")} ` +
        `error=0x${bytes[3]
          ?.toString(16)
          .padStart(2, "0")}`
      );

      return;
    }

    const dpiFeatureIndex =
      controller.logitechFeatures?.adjustableDpi ??
      this.adjustableDpiFeatureIndex;

    /*
      Adjustable DPI response layout, as seen in HID++ traces:

      11 01 <feature> <function+SWID> <sensor> <DPI-hi> <DPI-lo> ...

      Example:
      11 ff 0a 28 00 06 40 ...
                    ^^ ^^
                    1600 DPI

      Function 0x02 = GetSensorDPI
      Function 0x03 = SetSensorDPI
    */
    if (
      dpiFeatureIndex !== null &&
      dpiFeatureIndex !== undefined &&
      bytes[1] === dpiFeatureIndex &&
      bytes.length >= 6
    ) {
      const functionId =
        (bytes[2] >> 4) & 0x0f;

      const softwareId =
        bytes[2] & 0x0f;

      if (
        softwareId === HIDPP_SOFTWARE_ID &&
        (functionId === 0x02 ||
          functionId === 0x03)
      ) {
        this.currentSensorIndex =
          bytes[3];

        const dpiValue =
          (bytes[4] << 8) |
          bytes[5];

        if (
          dpiValue >= 100 &&
          dpiValue <= 25600
        ) {
          controller._emitDpiValue(
            dpiValue
          );

          // A DPI value read from the mouse is the most reliable
          // indication that a physical DPI stage changed.
          this._updateStageFromDpi(
            controller,
            dpiValue
          );

          return;
        }
      }
    }

    /*
      Legacy notification candidate.

      Some Logitech firmwares expose a notification feature on another
      dynamic index. We keep the old 0x09 path, but it is no longer the
      only mechanism: the controller also polls GetSensorDPI.
    */
    if (
      reportId === HIDPP_LONG_REPORT_ID &&
      bytes[1] === this.dpiEventFeatureIndex &&
      bytes.length >= 4
    ) {
      const stage = bytes[3];

      if (
        Number.isInteger(stage) &&
        stage >= 0 &&
        stage < this.dpiStageCount
      ) {
        controller._emitDpiStage(stage);

        // Read back the real DPI after the event.
        this.getDpi(controller);

        return;
      }
    }

    const batteryFeatureIndex =
      controller.logitechFeatures?.unifiedBattery ??
      this.batteryFeatureIndex;

    /*
      Unified Battery 0x1004, function 0x01:

      bytes[3] = battery percentage
      bytes[4] = charging/status byte
    */
    if (
      batteryFeatureIndex !== null &&
      batteryFeatureIndex !== undefined &&
      bytes[1] === batteryFeatureIndex &&
      bytes.length >= 5
    ) {
      const functionId =
        (bytes[2] >> 4) & 0x0f;

      const softwareId =
        bytes[2] & 0x0f;

      if (
        softwareId === HIDPP_SOFTWARE_ID &&
        functionId === 0x01
      ) {
        const percentage = bytes[3];
        const status = bytes[4];

        if (
          percentage >= 0 &&
          percentage <= 100
        ) {
          const isCharging =
            status === 0x01 ||
            status === 0x02;

          controller._emitBattery(
            percentage,
            isCharging
          );
        }
      }
    }
  },

  _updateStageFromDpi(
    controller,
    dpiValue
  ) {
    /*
      The firmware can change DPI without exposing a clean stage
      notification through WebHID. We therefore keep a stable list of
      DPI values observed from the device.

      If the same five values are encountered, their order is retained
      and the UI can show which observed stage is active.

      This is intentionally conservative: we never invent a stage
      number from the numeric DPI alone.
    */
    if (!controller.logitechDpiStages) {
      controller.logitechDpiStages = [];
    }

    let index =
      controller.logitechDpiStages.indexOf(
        dpiValue
      );

    if (index === -1) {
      if (
        controller.logitechDpiStages.length <
        this.dpiStageCount
      ) {
        controller.logitechDpiStages.push(
          dpiValue
        );

        index =
          controller.logitechDpiStages.length -
          1;
      }
    }

    if (
      index >= 0 &&
      index < this.dpiStageCount
    ) {
      controller._emitDpiStage(index);
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

    this.deviceIndex = 0xff;

    this._pollTimer = null;
    this._batteryTimer = null;
    this._dpiTimer = null;

    this._attackSharkReportCursor = 0x01;

    this._hidppWaiters = new Set();

    this.logitechFeatures = {
      unifiedBattery: null,
      adjustableDpi: null,
    };

    this.logitechDpiStages = [];

    this._boundInputReport =
      (event) => this._handleInputReport(event);

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
      this._error(
        "Conecte um mouse primeiro."
      );

      return false;
    }

    if (
      typeof this.profile.setDpi !==
      "function"
    ) {
      this._error(
        `Alterar DPI ainda não é suportado para o perfil "${this.profile.label}".`
      );

      return false;
    }

    if (
      !Number.isFinite(dpiValue) ||
      dpiValue <= 0
    ) {
      this._error(
        "Valor de DPI inválido."
      );

      return false;
    }

    return this.profile.setDpi(
      this,
      Math.round(dpiValue)
    );
  }

  async connect() {
    if (!MouseController.isSupported()) {
      this._error(
        "Este navegador não suporta WebHID. Use Chrome ou Edge atualizado."
      );

      return false;
    }

    try {
      const filters =
        DEVICE_PROFILES.map(
          (profile) => ({
            vendorId:
              profile.vendorId,
          })
        );

      const [device] =
        await navigator.hid.requestDevice({
          filters,
        });

      if (!device) {
        return false;
      }

      await device.open();

      this.device = device;
      this.profile =
        this._matchProfile(device);

      // The listener MUST exist before profile.init().
      device.addEventListener(
        "inputreport",
        this._boundInputReport
      );

      if (!this.profile) {
        this._error(
          "Dispositivo conectado, mas não reconhecido."
        );

        return true;
      }

      if (
        typeof this.onConnect ===
        "function"
      ) {
        this.onConnect({
          name:
            device.productName ||
            this.profile.label,
          vid: device.vendorId,
          pid: device.productId,
          connectionType:
            this.profile.connectionType(
              device.productId
            ),
          profileId:
            this.profile.id,
        });
      }

      await this.profile.init(
        this
      );

      return true;
    } catch (err) {
      this._handleConnectionError(
        err
      );

      return false;
    }
  }

  async disconnect() {
    this._stopAttackSharkPolling();
    this._stopLogitechBatteryPolling();
    this._stopLogitechDpiPolling();

    this._rejectAllHidppWaiters(
      new Error(
        "Dispositivo desconectado."
      )
    );

    if (this.device) {
      try {
        this.device.removeEventListener(
          "inputreport",
          this._boundInputReport
        );
      } catch (_err) {}

      try {
        await this.device.close();
      } catch (_err) {}
    }

    this.device = null;
    this.profile = null;
    this.deviceIndex = 0xff;

    this.logitechFeatures = {
      unifiedBattery: null,
      adjustableDpi: null,
    };

    this.logitechDpiStages = [];

    if (
      typeof this.onDisconnect ===
      "function"
    ) {
      this.onDisconnect();
    }
  }

  _matchProfile(device) {
    return (
      DEVICE_PROFILES.find(
        (profile) =>
          profile.vendorId ===
            device.vendorId &&
          device.productId in
            profile.productIds
      ) ?? null
    );
  }

  _handleConnectionError(err) {
    let msg;

    if (
      err.name ===
      "NotFoundError"
    ) {
      msg =
        "Nenhum mouse foi selecionado.";
    } else if (
      err.name ===
      "SecurityError"
    ) {
      msg =
        "Acesso HID bloqueado pelo navegador.";
    } else if (
      err.name ===
      "InvalidStateError"
    ) {
      msg =
        "O dispositivo já está aberto por outra aba/processo.";
    } else {
      msg =
        `Erro ao conectar: ${
          err?.message || err
        }`;
    }

    this._error(msg);
  }

  _error(message) {
    if (
      typeof this.onError ===
      "function"
    ) {
      this.onError(message);
    } else {
      console.warn(
        "[driverless-mouse]",
        message
      );
    }
  }

  _emitDpiStage(stage) {
    if (
      typeof this.onDpiStageChange ===
      "function"
    ) {
      this.onDpiStageChange(stage);
    }
  }

  _emitDpiValue(dpiValue) {
    if (
      typeof this.onDpiValueChange ===
      "function"
    ) {
      this.onDpiValueChange(
        dpiValue
      );
    }
  }

  _emitBattery(
    percentage,
    isCharging
  ) {
    if (
      typeof this.onBatteryUpdate ===
      "function"
    ) {
      this.onBatteryUpdate(
        percentage,
        isCharging
      );
    }
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

    // First give the report to any pending request.
    this._dispatchHidppWaiters(
      event.reportId,
      bytes
    );

    if (!this.profile) {
      return;
    }

    if (
      this.profile.id ===
      "logitech-g502x"
    ) {
      this.profile.handleInputReport(
        this,
        event.reportId,
        bytes
      );
    }
  }

  _waitForHidppResponse(
    matcher,
    timeoutMs = 450
  ) {
    return new Promise(
      (resolve, reject) => {
        const waiter = {
          timer: null,
          done: false,
          matcher,

          resolve: (value) => {
            if (waiter.done) return;

            waiter.done = true;

            if (waiter.timer) {
              clearTimeout(
                waiter.timer
              );
              waiter.timer = null;
            }

            this._hidppWaiters.delete(
              waiter
            );

            resolve(value);
          },

          reject: (err) => {
            if (waiter.done) return;

            waiter.done = true;

            if (waiter.timer) {
              clearTimeout(
                waiter.timer
              );
              waiter.timer = null;
            }

            this._hidppWaiters.delete(
              waiter
            );

            reject(err);
          },
        };

        waiter.timer = setTimeout(
          () => {
            waiter.reject(
              new Error(
                `Timeout HID++ após ${timeoutMs} ms.`
              )
            );
          },
          timeoutMs
        );

        this._hidppWaiters.add(
          waiter
        );
      }
    );
  }

  _dispatchHidppWaiters(
    reportId,
    bytes
  ) {
    for (
      const waiter of Array.from(
        this._hidppWaiters
      )
    ) {
      let matched = false;

      try {
        matched =
          waiter.matcher(
            reportId,
            bytes
          ) === true;
      } catch (_err) {
        matched = false;
      }

      if (matched) {
        waiter.resolve({
          reportId,
          bytes:
            Array.from(bytes),
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

  async _resolveHidppFeature(
    featureId,
    options = {}
  ) {
    const retries =
      Math.max(
        1,
        options.retries ?? 3
      );

    const timeoutMs =
      Math.max(
        100,
        options.timeoutMs ?? 450
      );

    const hi =
      (featureId >> 8) & 0xff;

    const lo =
      featureId & 0xff;

    for (
      let attempt = 1;
      attempt <= retries;
      attempt++
    ) {
      try {
        /*
          ROOT.GetFeature request:

          10 01 00 08 XX XX 00

          The request is Short Report 0x10.
          The response is normally Long Report 0x11:

          11 01 00 08 NN VV TT ...

          NN = allocated Feature Index.
        */
        const responsePromise =
          this._waitForHidppResponse(
            (reportId, bytes) => {
              if (
                reportId !==
                HIDPP_LONG_REPORT_ID
              ) {
                return false;
              }

              if (
                !bytes ||
                bytes.length < 6
              ) {
                return false;
              }

              return (
                bytes[0] ===
                  this.deviceIndex &&
                bytes[1] === 0x00 &&
                bytes[2] ===
                  ((0x00 << 4) |
                    HIDPP_SOFTWARE_ID)
              );
            },
            timeoutMs
          );

        const packet =
          buildHidppShortPacket(
            this.deviceIndex,
            0x00,
            0x00,
            [hi, lo, 0x00]
          );

        await this.device.sendReport(
          HIDPP_SHORT_REPORT_ID,
          packet
        );

        const response =
          await responsePromise;

        const bytes =
          response.bytes;

        const featureIndex =
          bytes[3];

        const version =
          bytes[4];

        const featureType =
          bytes[5];

        if (
          featureIndex === 0x00
        ) {
          throw new Error(
            `Feature 0x${featureId
              .toString(16)
              .padStart(4, "0")} não suportada.`
          );
        }

        return {
          featureId,
          featureIndex,
          version,
          featureType,
          reportId:
            response.reportId,
          attempt,
        };
      } catch (err) {
        if (
          attempt >= retries
        ) {
          throw err;
        }

        await this._sleep(
          50 * attempt
        );
      }
    }

    throw new Error(
      "ROOT.GetFeature falhou."
    );
  }

  async _sendHidppShort(
    featureIndex,
    functionId,
    params,
    label,
    silentFail = false
  ) {
    if (!this.device) {
      return false;
    }

    const data =
      buildHidppShortPacket(
        this.deviceIndex,
        featureIndex,
        functionId,
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

  async _logitechPing() {
    // RAP GetProtocolVersion.
    // With SWID 0x08 this is 10 01 00 18 00 00 5a.
    return this._sendHidppShort(
      0x00,
      0x01,
      [0x00, 0x00, 0x5a],
      "GetProtocolVersion",
      true
    );
  }

  async _logitechRequestBattery() {
    const featureIndex =
      this.logitechFeatures
        ?.unifiedBattery ??
      this.profile
        ?.batteryFeatureIndex;

    if (
      featureIndex === null ||
      featureIndex === undefined
    ) {
      return false;
    }

    // Unified Battery GetStatus = function 0x01.
    return this._sendHidppShort(
      featureIndex,
      0x01,
      [0x00, 0x00, 0x00],
      "Unified Battery GetStatus",
      true
    );
  }

  _startLogitechBatteryPolling() {
    this._stopLogitechBatteryPolling();

    this._batteryTimer =
      setInterval(
        () => {
          if (!this.device) return;

          this._logitechRequestBattery();
        },
        this.profile
          .batteryPollIntervalMs
      );
  }

  _stopLogitechBatteryPolling() {
    if (this._batteryTimer) {
      clearInterval(
        this._batteryTimer
      );

      this._batteryTimer = null;
    }
  }

  _startLogitechDpiPolling() {
    this._stopLogitechDpiPolling();

    this._dpiTimer =
      setInterval(
        () => {
          if (
            !this.device ||
            !this.profile
          ) {
            return;
          }

          this.profile.getDpi(
            this
          );
        },
        this.profile
          .dpiPollIntervalMs
      );
  }

  _stopLogitechDpiPolling() {
    if (this._dpiTimer) {
      clearInterval(
        this._dpiTimer
      );

      this._dpiTimer = null;
    }
  }

  _startAttackSharkPolling() {
    this._stopAttackSharkPolling();

    this._attackSharkReportCursor =
      0x01;

    this._pollTimer =
      setInterval(
        async () => {
          if (
            !this.device ||
            !this.profile
          ) {
            return;
          }

          const reportId =
            this
              ._attackSharkReportCursor;

          await this.profile.pollStep(
            this,
            reportId
          );

          this
            ._attackSharkReportCursor +=
            1;

          if (
            this
              ._attackSharkReportCursor >
            0x20
          ) {
            this
              ._attackSharkReportCursor =
              0x01;
          }
        },
        this.profile
          .pollIntervalMs
      );
  }

  _stopAttackSharkPolling() {
    if (this._pollTimer) {
      clearInterval(
        this._pollTimer
      );

      this._pollTimer = null;
    }
  }

  _handleAttackSharkFeatureReport(
    reportId,
    bytes
  ) {
    if (
      this.profile.dpiReportId ===
        null ||
      reportId !==
        this.profile.dpiReportId
    ) {
      return;
    }

    const stage =
      this.profile.parseDpiStage(
        bytes
      );

    if (stage !== null) {
      this._emitDpiStage(
        stage
      );
    }
  }

  _sleep(ms) {
    return new Promise(
      (resolve) =>
        setTimeout(resolve, ms)
    );
  }
}

export {
  DEVICE_PROFILES,
  ATTACK_SHARK_V3,
  LOGITECH_G502X,
};