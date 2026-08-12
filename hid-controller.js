/* =========================================================================
   driverless-mouse — hid-controller.js
   Motor de controle WebHID para a fase final do projeto.

   Consolida os resultados da engenharia reversa feita com o
   hid-diagnostic.html para dois dispositivos:

     • Attack Shark V3   (VID 0x1d57 · PID 0xfa60 dongle / 0x215a cabo)
     • Logitech G502 X   (VID 0x046d · PID 0xc098, protocolo HID++ 2.0)

   Uso (ES module):
     import { MouseController } from "./hid-controller.js";
     const controller = new MouseController();
     controller.onConnect = (info) => ...
     controller.onDpiStageChange = (stage) => ...
     controller.onBatteryUpdate = (percentage, isCharging) => ...
     controller.onError = (message) => ...
     await controller.connect();
   ========================================================================= */

// -----------------------------------------------------------------------
// Constantes HID++ 2.0 (Logitech)
// Estrutura confirmada via Logitech/cpg-docs e validada empiricamente
// no hid-diagnostic.html: [devIdx, featureIdx, (func<<4|swId), p0, p1, p2]
// -----------------------------------------------------------------------
const HIDPP_SHORT_REPORT_ID = 0x10;
const HIDPP_LONG_REPORT_ID = 0x11;
const HIDPP_SOFTWARE_ID = 0x01;

function buildHidppShortPacket(deviceIndex, featureIndex, functionId, params) {
  const p = [0, 0, 0];
  (params || []).forEach((v, i) => { if (i < 3) p[i] = v & 0xff; });
  const funcByte = ((functionId & 0x0f) << 4) | (HIDPP_SOFTWARE_ID & 0x0f);
  return new Uint8Array([deviceIndex & 0xff, featureIndex & 0xff, funcByte, ...p]);
}

// -----------------------------------------------------------------------
// Perfil: Attack Shark V3
//
// Achado da engenharia reversa: o firmware NÃO envia inputreport
// espontâneo para mudanças de DPI. É preciso sondar ativamente os
// Feature Reports (0x01–0x20) via receiveFeatureReport().
//
// O QUE AINDA FALTA (marcado abaixo): qual desses IDs, e em qual byte,
// carrega o valor de DPI. O hid-diagnostic.html já te dá a ferramenta
// certa pra descobrir isso (painel de Probe) — quando você identificar,
// preencha `dpiReportId` e `dpiByteOffset` e o resto do motor já funciona
// sem mudanças (o polling e a emissão de eventos já estão prontos).
// -----------------------------------------------------------------------
const ATTACK_SHARK_V3 = {
  id: "attack-shark-v3",
  label: "Attack Shark V3",
  vendorId: 0x1d57,
  productIds: {
    0xfa60: "Dongle 2.4GHz",
    0x215a: "Cabo USB",
  },

  // TODO / DESCOBRIR — preencha com o resultado do Probe no hid-diagnostic.html
  dpiReportId: null,   // ex: 0x05
  dpiByteOffset: null, // ex: 2

  pollIntervalMs: 400, // frequência da sondagem ativa de feature reports

  connectionType(productId) {
    return this.productIds[productId] || "Desconhecido";
  },

  /** Chamado uma vez logo após a conexão ser aberta. */
  async init(controller) {
    controller._startAttackSharkPolling();
  },

  /**
   * Sonda um único Feature Report e repassa para o controller processar.
   * Usado pelo poller genérico em MouseController.
   */
  async pollStep(controller, reportId) {
    try {
      const view = await controller.device.receiveFeatureReport(reportId);
      const bytes = Array.from(new Uint8Array(view.buffer));
      controller._handleAttackSharkFeatureReport(reportId, bytes);
    } catch (_err) {
      // Report ID não suportado nesse índice — esperado para a maioria, ignora.
    }
  },

  /** Interpreta um relatório já confirmado como o de DPI (quando mapeado). */
  parseDpiStage(bytes) {
    if (this.dpiByteOffset === null || bytes.length <= this.dpiByteOffset) return null;
    return bytes[this.dpiByteOffset];
  },
};

// -----------------------------------------------------------------------
// Perfil: Logitech G502 X LIGHTSPEED (HID++ 2.0)
//
// Dados confirmados via engenharia reversa:
//   - Handshake: Ping ao Root (feature idx 0, função 1, params [0,0,0x5a])
//     "acorda" o dispositivo e o faz começar a notificar espontaneamente.
//   - DPI: após o handshake, o mouse envia notificações espontâneas no
//     Report ID 0x11 (longo). Feature idx 0x09 (observado na captura),
//     função 1 (evento), byte de parâmetro 0 (índice 3 do payload) = estágio
//     de DPI atual (0–4, os 5 perfis onboard).
//   - Bateria: feature Unified Battery (0x1004) resolvida no índice 0x06.
//     GetStatus (função 0x00) devolve [percentual, status de carga, ...]
//     nos bytes de parâmetro da resposta.
// -----------------------------------------------------------------------
const LOGITECH_G502X = {
  id: "logitech-g502x",
  label: "Logitech G502 X LIGHTSPEED",
  vendorId: 0x046d,
  productIds: {
    0xc098: "Cabo USB",
    0xc547: "Sem fio / Dongle LIGHTSPEED",
  },

  // Aceitos como Device Index válido em respostas/notificações HID++.
  // 0xff = mouse falando direto (cabo) · 0x01 = mouse pareado no dongle (slot 1).
  knownDeviceIndexes: [0xff, 0x01],

  batteryFeatureIndex: 0x06,
  dpiEventFeatureIndex: 0x09, // observado empiricamente na captura de eventos de DPI
  dpiStageCount: 5,

  batteryPollIntervalMs: 30000, // bateria não é espontânea, precisa ser sondada

  connectionType(productId) {
    return this.productIds[productId] || "Sem fio";
  },

  /**
   * Resolve o Device Index a usar nos comandos de saída (Ping, GetStatus...).
   * Cabo (0xc098) fala direto com o mouse -> 0xff.
   * Dongle (0xc547) enderaça o mouse pareado no slot 1 do receptor -> 0x01.
   */
  resolveDeviceIndex(productId) {
    return productId === 0xc547 ? 0x01 : 0xff;
  },

  async init(controller) {
    controller.deviceIndex = this.resolveDeviceIndex(controller.device.productId);
    await controller._logitechPing();
    await new Promise((r) => setTimeout(r, 150));
    await controller._logitechRequestBattery(); // primeira leitura imediata
    controller._startLogitechBatteryPolling();
  },

  /** Trata um inputreport HID++ já roteado pelo controller. */
  handleInputReport(controller, reportId, bytes) {
    const deviceIndexOk = this.knownDeviceIndexes.includes(bytes[0]);

    // Notificação espontânea de troca de estágio de DPI.
    if (
      deviceIndexOk &&
      reportId === HIDPP_LONG_REPORT_ID &&
      bytes[1] === this.dpiEventFeatureIndex &&
      bytes.length > 3
    ) {
      const stage = bytes[3];
      if (stage >= 0 && stage < this.dpiStageCount) {
        controller._emitDpiStage(stage);
        return;
      }
    }

    // Resposta ao pedido de bateria (feature idx 0x06, GetStatus).
    if (
      deviceIndexOk &&
      (reportId === HIDPP_SHORT_REPORT_ID || reportId === HIDPP_LONG_REPORT_ID) &&
      bytes[1] === this.batteryFeatureIndex
    ) {
      // Layout best-effort baseado no padrão comum de Unified Battery
      // (0x1004): byte0 = percentual, byte1 = estado de carga.
      // Se os números vierem estranhos no seu firmware, confirme os
      // offsets exatos com o console customizado do hid-diagnostic.html.
      const percentage = bytes[3];
      const chargingStatus = bytes[4];
      const isCharging = chargingStatus === 1 || chargingStatus === 2;
      if (percentage >= 0 && percentage <= 100) {
        controller._emitBattery(percentage, isCharging);
      }
    }
  },
};

const DEVICE_PROFILES = [ATTACK_SHARK_V3, LOGITECH_G502X];

// -----------------------------------------------------------------------
// Controller principal
// -----------------------------------------------------------------------

export class MouseController {
  constructor() {
    /** @type {HIDDevice | null} */
    this.device = null;
    this.profile = null;

    this._pollTimer = null;
    this._batteryTimer = null;
    this._attackSharkReportCursor = 0x01;
    this.deviceIndex = 0xff; // resolvido dinamicamente por perfil.init() (ex: Logitech via cabo/dongle)

    // Callbacks públicos — a UI atribui essas propriedades.
    this.onConnect = null;        // (info: {name, vid, pid, connectionType, profileId}) => void
    this.onDisconnect = null;     // () => void
    this.onDpiStageChange = null; // (stageIndex: number) => void
    this.onBatteryUpdate = null;  // (percentage: number, isCharging: boolean) => void
    this.onError = null;          // (message: string) => void
  }

  static isSupported() {
    return "hid" in navigator;
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
        this._error(
          `Dispositivo "${device.productName}" conectado, mas não reconhecido pelos perfis mapeados (VID 0x${device.vendorId.toString(16)}, PID 0x${device.productId.toString(16)}).`
        );
        return true; // conexão abriu, só não tem perfil — a UI decide o que mostrar
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
    let msg;
    if (err.name === "NotFoundError") {
      msg = "Nenhum mouse foi selecionado.";
    } else if (err.name === "SecurityError") {
      msg = "Acesso HID bloqueado pelo navegador. Confirme que a página está em HTTPS ou localhost.";
    } else if (err.name === "InvalidStateError") {
      msg = "O dispositivo já está aberto por outra aba/processo.";
    } else {
      msg = `Erro ao conectar: ${err.message}`;
    }
    this._error(msg);
  }

  _error(message) {
    if (typeof this.onError === "function") this.onError(message);
    else console.warn("[driverless-mouse]", message);
  }

  _emitDpiStage(stage) {
    if (typeof this.onDpiStageChange === "function") this.onDpiStageChange(stage);
  }

  _emitBattery(percentage, isCharging) {
    if (typeof this.onBatteryUpdate === "function") this.onBatteryUpdate(percentage, isCharging);
  }

  // ---------------------------------------------------------------------
  // Roteamento de inputreport para o perfil ativo
  // ---------------------------------------------------------------------

  _handleInputReport(event) {
    if (!this.profile) return;
    const bytes = Array.from(new Uint8Array(event.data.buffer));

    if (this.profile.id === "logitech-g502x") {
      this.profile.handleInputReport(this, event.reportId, bytes);
    }
    // Attack Shark não usa inputreport espontâneo — tratado via polling (abaixo).
  }

  // ---------------------------------------------------------------------
  // Attack Shark V3 — sondagem ativa de Feature Reports
  // ---------------------------------------------------------------------

  _startAttackSharkPolling() {
    this._stopAttackSharkPolling();
    this._attackSharkReportCursor = 0x01;

    this._pollTimer = setInterval(async () => {
      if (!this.device || !this.profile) return;

      // Percorre 0x01–0x20 continuamente, um ID por tick, para não
      // sobrecarregar o barramento com 32 requisições simultâneas.
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

  // ---------------------------------------------------------------------
  // Logitech G502 X — HID++ 2.0
  // ---------------------------------------------------------------------

  async _sendHidppShort(featureIndex, functionId, params, label) {
    if (!this.device) return false;
    const data = buildHidppShortPacket(this.deviceIndex, featureIndex, functionId, params);
    try {
      await this.device.sendReport(HIDPP_SHORT_REPORT_ID, data);
      return true;
    } catch (err) {
      const msg =
        err.name === "InvalidStateError"
          ? `Falha ao enviar "${label}": interface ocupada. Feche o Logitech G HUB e tente novamente.`
          : `Falha ao enviar "${label}": ${err.message}`;
      this._error(msg);
      return false;
    }
  }

  async _logitechPing() {
    await this._sendHidppShort(0x00, 0x01, [0x00, 0x00, 0x5a], "Ping (GetProtocolVersion)");
  }

  async _logitechRequestBattery() {
    await this._sendHidppShort(
      this.profile.batteryFeatureIndex,
      0x00,
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