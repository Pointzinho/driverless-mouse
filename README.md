# 🖱️ Driverless Mouse

> **Painel de Controle Universal WebHID para Mouses Gamer**

Uma interface leve, rápida e **100% portátil** para configurar DPI e verificar a bateria do seu mouse gamer diretamente pelo navegador ou via arquivo executável offline. Tudo isso sem precisar instalar softwares pesados de fabricantes e sem exigir privilégios de administrador.

## ✨ Funcionalidades

* **Sem Instalação:** Rode direto pelo Google Chrome/Edge via WebHID ou baixe o executável portátil (`.exe`).
* **Configuração de DPI:** Altere os estágios de DPI do seu mouse em tempo real com uma interface visual arrastável.
* **Monitoramento de Bateria:** Leitura direta do hardware informando a porcentagem exata e o status de carregamento.
* **Auto-Detecção:** Identifica automaticamente se o mouse está conectado via Cabo USB ou Dongle sem fio.

## 🖱️ Dispositivos Suportados

| Mouse | Status | Conexões Suportadas |
| :--- | :---: | :--- |
| **Logitech G502 X LIGHTSPEED** | 🟢 Suportado | Cabo USB & Dongle (LIGHTSPEED) |
| **Attack Shark V3** | 🟢 Suportado | Cabo USB & Dongle (2.4GHz) |

*Nota: Mouses da Logitech com pareamento via receptor unificado podem necessitar de ajustes no Device Index.*

## 🚀 Como Usar

Você tem duas formas de utilizar o Driverless Mouse:

### Opção 1: Aplicativo Portátil (Recomendado)
Para uma experiência nativa e offline:
1. Vá até a aba [Releases](../../releases) do repositório.
2. Baixe o arquivo `DrivelessMouse_Beta.exe`.
3. Dê um duplo clique para abrir e clique em **Conectar Mouse**.

### Opção 2: Direto pelo Navegador
1. Acesse o link do projeto hospedado (se configurado no GitHub Pages) usando Google Chrome, Microsoft Edge ou Opera.
2. Clique em **Conectar Mouse**.
3. Na janela do navegador que se abrir, selecione a interface correspondente ao seu mouse (geralmente a que possui o nome do dispositivo ou do Dongle).

## 🛠️ Solução de Problemas (Troubleshooting)

**Erro "Failed to write the report" no G502 X (Ghost Lock)**
Se o mouse não estiver salvando o DPI, ele pode estar com a Memória Integrada bloqueada pelo software oficial da Logitech (G HUB). Para destravar:
1. Abra o Logitech G HUB.
2. Ative o "Modo de Memória Integrada" e clique em **Restaurar configurações originais** no perfil.
3. Conecte o mouse via Cabo USB, desligue a chave física embaixo dele e ligue novamente.
4. Desconecte o cabo, volte para o Dongle sem fio e **feche completamente o G HUB** (verifique a bandeja do sistema).
5. Abra o Driverless Mouse novamente.

## 💻 Para Desenvolvedores (Como compilar o `.exe`)

Este projeto utiliza **Electron** para gerar o executável portátil.

**Pré-requisitos:** Node.js instalado.

```bash
# 1. Clone o repositório
git clone [https://github.com/Pointzinho/driverless-mouse.git](https://github.com/Pointzinho/driverless-mouse.git)

# 2. Instale as dependências
npm install

# 3. Teste o aplicativo em ambiente de desenvolvimento
npm run start

# 4. Compile o executável para Windows (Gera a pasta /dist)
npm run build
