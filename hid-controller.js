/* =========================================================================
   driverless-mouse — hid-controller.js
   Módulo WebHID para leitura/escrita de configurações em mouses gamer
   (Attack Shark V3 e Logitech série G) direto do navegador, sem drivers.

   COMO USAR:
   Cole este bloco dentro de <script> no seu index.html, ou importe como
   módulo (<script type="module" src="hid-controller.js">).

   IMPORTANTE — LEIA ANTES DE USAR:
   Os VID/PID e os offsets de byte marcados como "TODO / DESCOBRIR" são
   PLACEHOLDERS. A Attack Shark e a Logitech não publicam a especificação
   do protocolo HID de configuração (DPI, polling rate, etc). Isso precisa
   ser descoberto por engenharia reversa. A função `logRawReport()` no
   final deste arquivo foi feita exatamente pra te ajudar a descobrir esses
   valores rapidamente — veja as instruções no rodapé.
   ========================================================================= */

// -----------------------------------------------------------------------
// 1. REGISTRO DE PERFIS DE DISPOSITIVO
//    Cada perfil descreve como conversar com um mouse específico.
//    Preencha vendorId/productId reais (obtidos via navigator.hid.requestDevice)
//    e os offsets de byte reais (descobertos via logRawReport).
// -----------------------------------------------------------------------

const DEVICE_PROFILES = {
  ATTACK_SHARK_V3: {
    label: "Attack Shark V3",
    vendorId: 0x0000,   // TODO / DESCOBRIR: rode requestDevice() e leia device.vendorId
    productId: 0x0000,  // TODO / DESCOBRIR: idem, device.productId

    // A maioria dos mouses gamer baratos (chips BK52xx, como o V3 usa)
    // conversa via Feature Report em vez de Output Report simples.
    // Ajuste reportType conforme o que você observar em logRawReport().
    reportType: "feature", // "feature" | "output"
    reportId: 0x05,         // TODO / DESCOBRIR

    // Mapas de DPI/Hz -> valor de byte a enviar. Preencha depois de capturar
    // o tráfego do software oficial (ou botões físicos) trocando cada valor.
    dpiMap: {
      400: 0x00,
      800: 0x01,
      1600: 0x02,
      3200: 0x03,
      6400: 0x04,
    },
    pollingRateMap: {
      125: 0x00,
      500: 0x01,
      1000: 0x02,
    },

    // Monta o payload de bytes para trocar o DPI. TODO: ajustar layout real.
    buildDpiPacket(dpiValueByte) {
      const packet = new Uint8Array(8);
      packet[0] = 0x04;          // TODO: comando "set DPI" (placeholder)
      packet[1] = dpiValueByte;
      return packet;
    },

    buildPollingRatePacket(hzValueByte) {
      const packet = new Uint8Array(8);
      packet[0] = 0x06;          // TODO: comando "set polling rate" (placeholder)
      packet[1] = hzValueByte;
      return packet;
    },

    // Interpreta um inputreport recebido do mouse (bateria, perfil ativo).
    // TODO: ajustar offsets reais depois de inspecionar os bytes crus.
    parseInputReport(dataView) {
      return {
        battery: dataView.byteLength > 2 ? dataView.getUint8(2) : null, // placeholder
        activeProfile: dataView.byteLength > 3 ? dataView.getUint8(3) : null, // placeholder
      };
    },
  },

  LOGITECH_G: {
    label: "Logitech (Série G)",
    vendorId: 0x046d, // confirmado pelo usuário
    productId: 0x0000, // TODO / DESCOBRIR: varia por modelo exato (G102, G Pro, G502, etc)

    // Mouses Logitech modernos usam o protocolo HID++ 2.0 sobre feature reports.
    // Implementar HID++ completo exige mapear "features" por índice (0x00 root,
    // 0x2201 Adjustable DPI, 0x8060 Reportrate, etc). Isso é bem mais estruturado
    // que um protocolo genérico — deixei os hooks prontos abaixo.
    reportType: "feature",
    reportId: 0x11, // Long report HID++ 2.0 (0x10 = short, 0x11 = long) — comum, mas confirme

    // HID++: índice de feature descoberto via "root.getFeature()" (0x0000).
    // TODO / DESCOBRIR: os índices reais mudam por firmware/modelo.
    features: {
      ADJUSTABLE_DPI: 0x00, // placeholder — precisa consultar o featureset do device
      REPORT_RATE: 0x00,    // placeholder
      BATTERY: 0x00,        // placeholder
    },

    dpiMap: {
      400: 0x0190,
      800: 0x0320,
      1600: 0x0640,
      3200: 0x0C80,
      6400: 0x1900,
    },
    pollingRateMap: {
      125: 0x08,
      500: 0x02,
      1000: 0x01,
    },

    buildDpiPacket(dpiValue16) {
      // Estrutura típica de um pacote HID++ 2.0 longo (20 bytes):
      // [reportId, deviceIndex, featureIndex, funcId|swId, params...]
      const packet = new Uint8Array(20);
      packet[0] = 0x11;                 // reportId longo
      packet[1] = 0xff;                 // deviceIndex (0xff = wired/receptor direto)
      packet[2] = this.features.ADJUSTABLE_DPI; // TODO: índice real da feature
      packet[3] = 0x30;                 // TODO: funcId "setDPI" (placeholder)
      packet[4] = 0x00;                 // sensor index (geralmente 0)
      packet[5] = (dpiValue16 >> 8) & 0xff;
      packet[6] = dpiValue16 & 0xff;
      return packet;
    },

    buildPollingRatePacket(hzByte) {
      const packet = new Uint8Array(20);
      packet[0] = 0x11;
      packet[1] = 0xff;
      packet[2] = this.features.REPORT_RATE; // TODO: índice real
      packet[3] = 0x30;                       // TODO: funcId real
      packet[4] = hzByte;
      return packet;
    },

    parseInputReport(dataView) {
      return {
        battery: dataView.byteLength > 4 ? dataView.getUint8(4) : null, // placeholder
        activeProfile: null, // Logitech G geralmente não expõe "perfil" via HID++ básico
      };
    },
  },
};

// -----------------------------------------------------------------------
// 2. CONTROLADOR PRINCIPAL
// -----------------------------------------------------------------------

class MouseHidController {
  constructor() {
    /** @type {HIDDevice | null} */
    this.device = null;
    /** @type {object | null} */
    this.profile = null;
    this.onStatusUpdate = null; // callback opcional: (status) => void
  }

  /** Verifica se o navegador suporta WebHID */
  static isSupported() {
    return "hid" in navigator;
  }

  /**
   * Abre o seletor nativo do navegador e conecta ao mouse escolhido.
   * Identifica automaticamente o perfil (Attack Shark ou Logitech) pelo VID.
   */
  async connect() {
    if (!MouseHidController.isSupported()) {
      throw new Error(
        "Este navegador não suporta WebHID. Use Chrome ou Edge atualizado."
      );
    }

    try {
      const filters = Object.values(DEVICE_PROFILES).map((p) => ({
        vendorId: p.vendorId,
      }));

      const [device] = await navigator.hid.requestDevice({ filters });

      if (!device) {
        throw new Error("Nenhum dispositivo selecionado.");
      }

      await device.open();

      this.device = device;
      this.profile = this._matchProfile(device);

      // Escuta relatórios espontâneos do mouse (bateria, perfil, etc)
      device.addEventListener("inputreport", (event) =>
        this._handleInputReport(event)
      );

      this._notify({
        type: "connected",
        deviceName: device.productName,
        profile: this.profile?.label ?? "desconhecido (perfil não mapeado)",
      });

      return device;
    } catch (err) {
      this._handleConnectionError(err);
      throw err;
    }
  }

  _matchProfile(device) {
    return (
      Object.values(DEVICE_PROFILES).find(
        (p) =>
          p.vendorId === device.vendorId &&
          (p.productId === 0x0000 || p.productId === device.productId)
      ) ?? null
    );
  }

  /** Trata erros comuns de conexão de forma amigável para o usuário final */
  _handleConnectionError(err) {
    let friendlyMessage;

    if (err.name === "NotFoundError") {
      friendlyMessage =
        "Nenhum mouse foi selecionado, ou o navegador não encontrou dispositivos HID compatíveis.";
    } else if (err.name === "SecurityError") {
      friendlyMessage =
        "O navegador bloqueou o acesso HID. Confirme que a página está em HTTPS (ou localhost).";
    } else if (err.name === "InvalidStateError") {
      friendlyMessage =
        "O dispositivo já está aberto por outra aba ou processo.";
    } else {
      friendlyMessage = `Erro ao conectar: ${err.message}`;
    }

    this._notify({ type: "error", message: friendlyMessage, raw: err });
  }

  /**
   * Envia um relatório para o dispositivo, com fallback entre
   * sendFeatureReport e sendReport conforme o perfil, e tratamento de erro
   * amigável caso a interface esteja ocupada/recuse o pacote.
   */
  async _send(packet) {
    if (!this.device || !this.device.opened) {
      this._notify({
        type: "error",
        message: "Nenhum mouse conectado. Conecte o dispositivo antes de enviar comandos.",
      });
      return false;
    }
    if (!this.profile) {
      this._notify({
        type: "error",
        message:
          "Dispositivo conectado, mas o protocolo dele ainda não está mapeado em DEVICE_PROFILES.",
      });
      return false;
    }

    const reportId = this.profile.reportId ?? 0x00;

    try {
      if (this.profile.reportType === "feature") {
        await this.device.sendFeatureReport(reportId, packet);
      } else {
        await this.device.sendReport(reportId, packet);
      }
      return true;
    } catch (err) {
      // Caso mais comum na prática: a interface HID está "ocupada" porque
      // o software oficial do fabricante também está rodando e segurando
      // o dispositivo, ou o SO recusou a escrita.
      let friendlyMessage;
      if (err.name === "InvalidStateError") {
        friendlyMessage =
          "O mouse recusou o comando: a interface parece estar ocupada. Feche o software oficial do fabricante (se estiver aberto) e tente novamente.";
      } else if (err.name === "NetworkError") {
        friendlyMessage =
          "Falha de comunicação com o dispositivo. Desconecte e reconecte o mouse (USB) e tente de novo.";
      } else {
        friendlyMessage = `Falha ao enviar comando para o mouse: ${err.message}`;
      }

      this._notify({ type: "error", message: friendlyMessage, raw: err });
      return false;
    }
  }

  /** Define o DPI do mouse conectado (ex: 400, 800, 1600, 3200, 6400) */
  async setDpi(dpiValue) {
    if (!this.profile) return false;
    const mapped = this.profile.dpiMap[dpiValue];
    if (mapped === undefined) {
      this._notify({
        type: "error",
        message: `DPI ${dpiValue} não é suportado neste perfil.`,
      });
      return false;
    }
    const packet = this.profile.buildDpiPacket(mapped);
    const ok = await this._send(packet);
    if (ok) this._notify({ type: "dpi-changed", value: dpiValue });
    return ok;
  }

  /** Define a taxa de polling do mouse conectado (ex: 125, 500, 1000 Hz) */
  async setPollingRate(hz) {
    if (!this.profile) return false;
    const mapped = this.profile.pollingRateMap[hz];
    if (mapped === undefined) {
      this._notify({
        type: "error",
        message: `Polling rate ${hz}Hz não é suportado neste perfil.`,
      });
      return false;
    }
    const packet = this.profile.buildPollingRatePacket(mapped);
    const ok = await this._send(packet);
    if (ok) this._notify({ type: "polling-rate-changed", value: hz });
    return ok;
  }

  /** Handler chamado automaticamente quando o mouse manda um inputreport */
  _handleInputReport(event) {
    if (!this.profile) {
      // Perfil ainda não mapeado: apenas repassa os dados crus.
      this._notify({
        type: "raw-input-report",
        reportId: event.reportId,
        data: new Uint8Array(event.data.buffer),
      });
      return;
    }

    const parsed = this.profile.parseInputReport(event.data);
    this._notify({ type: "state-update", ...parsed });
  }

  _notify(status) {
    if (typeof this.onStatusUpdate === "function") {
      this.onStatusUpdate(status);
    } else {
      console.log("[driverless-mouse]", status);
    }
  }

  async disconnect() {
    if (this.device) {
      await this.device.close();
      this._notify({ type: "disconnected" });
      this.device = null;
      this.profile = null;
    }
  }
}

// -----------------------------------------------------------------------
// 3. FERRAMENTA DE ENGENHARIA REVERSA — logRawReport()
//
//    Como usar para descobrir o protocolo real de um mouse:
//    1. Chame `startRawLogging()` no console do navegador após conectar.
//    2. Abra o software OFICIAL do fabricante (ou aperte o botão físico
//       de DPI/polling no próprio mouse, se ele tiver).
//    3. Mude o DPI de 400 -> 800 -> 1600, etc, um valor por vez.
//    4. Observe no console os bytes que aparecem: o byte que muda de
//       forma previsível junto com o DPI é o offset que você quer.
//    5. Repita para polling rate e para o estado inicial (bateria/perfil).
//    Isso substitui os placeholders acima por valores reais.
// -----------------------------------------------------------------------

function startRawLogging(device) {
  if (!device) {
    console.warn("Passe uma instância de HIDDevice já aberta/conectada.");
    return;
  }
  device.addEventListener("inputreport", (event) => {
    const bytes = Array.from(new Uint8Array(event.data.buffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    console.log(
      `[RAW inputreport] reportId=0x${event.reportId
        .toString(16)
        .padStart(2, "0")} bytes: ${bytes}`
    );
  });
  console.log(
    "Logging ativado. Abra o software oficial do mouse e mude DPI/polling para ver os bytes."
  );
}

// -----------------------------------------------------------------------
// 4. EXEMPLO DE USO (adapte aos IDs do seu HTML)
// -----------------------------------------------------------------------
/*
const controller = new MouseHidController();

controller.onStatusUpdate = (status) => {
  switch (status.type) {
    case "connected":
      console.log(`Conectado: ${status.deviceName} (${status.profile})`);
      break;
    case "state-update":
      console.log(`Bateria: ${status.battery}% | Perfil ativo: ${status.activeProfile}`);
      break;
    case "error":
      alert(status.message); // ou renderize num toast/banner na sua UI
      break;
    default:
      console.log(status);
  }
};

document.getElementById("btn-connect").addEventListener("click", async () => {
  try {
    await controller.connect();
  } catch {
    // erro já tratado e notificado via onStatusUpdate
  }
});

document.getElementById("dpi-select").addEventListener("change", (e) => {
  controller.setDpi(Number(e.target.value));
});

document.getElementById("polling-select").addEventListener("change", (e) => {
  controller.setPollingRate(Number(e.target.value));
});
*/

export { MouseHidController, DEVICE_PROFILES, startRawLogging };
