# 🖱️ Driverless Mouse

> **Universal WebHID Control Panel for Gaming Mice**  
> Uma interface web portátil e leve para configurar DPI, Polling Rate e preferências de mouses gamer diretamente do navegador, sem instalar drivers ou necessitar de permissão de administrador.

---

## 📌 Sobre o Projeto

Em ambientes corporativos ou computadores restritos por políticas de TI, a instalação de softwares e drivers proprietários (como Logitech G HUB, drivers BKM/Attack Shark, etc.) costuma ser bloqueada por exigir privilégios de administrador.

O **Driverless Mouse** resolve esse problema utilizando a API nativa **WebHID** presente no Google Chrome e Microsoft Edge. Com ele, você consegue comunicar-se via USB/Dongle diretamente com a memória onboard do mouse sem precisar baixar ou instalar nenhum arquivo `.exe`.

---

## ✨ Funcionalidades

* 🚀 **Zero Instalação:** Funciona 100% via web pelo navegador.
* 🛡️ **Sem Privilégios de Admin:** Não dispara alertas do Windows nem requer senhas de administrador.
* 🎯 **Ajuste de DPI:** Altere os perfis de sensibilidade gravados no hardware.
* ⚡ **Polling Rate:** Alterne taxas de atualização (125Hz, 500Hz, 1000Hz).
* 🔄 **Suporte Multimarca:** Projetado para reconhecer dispositivos **Attack Shark** e **Logitech**.
* 💾 **Memória Onboard:** As alterações feitas via WebHID permanecem gravadas diretamente na memória interna do mouse.

---

## 🛠️ Tecnologias Utilizadas

* **HTML5 / CSS3 / JavaScript (ES6+)**
* **WebHID API** (Comunicação USB em user-space)
* **GitHub Pages** (Hospedagem e deploy contínuo)

---

## 🚀 Como Usar

1. Conecte seu mouse no computador via cabo USB ou Dongle 2.4GHz.
2. Abra um navegador compatível (**Google Chrome** ou **Microsoft Edge**).
3. Acesse a aplicação online no link do projeto.
4. Clique em **Conectar Mouse USB** e selecione seu dispositivo na caixa de diálogo nativa do navegador.
5. Ajuste as configurações desejadas e clique em **Aplicar Configurações**.

---

## 🔌 Dispositivos Mapeados / Em Desenvolvimento

| Marca | Modelo | Suporte |
| :--- | :--- | :---: |
| **Attack Shark** | V3 | 🟡 Em Testes |
| **Logitech** | Séries G (G203, G305, etc.) | 🟡 Em Testes |

---

## 📄 Licença

Distribuído sob a licença MIT. Veja `LICENSE` para mais informações.
