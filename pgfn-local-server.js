import express from "express";
import { chromium } from "playwright-core";
import chromiumBinary from "@sparticuz/chromium";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BITRIX_WEBHOOK = "https://mfinternacional.bitrix24.com.br/rest/4/mobey5stbpx9eb0n/";
const API_KEY = process.env.PGFN_API_KEY || null; // chave simples para proteger o endpoint

// Função principal de busca PGFN
async function consultarPGFN(company_id, cnpjRaw) {
try {
// Se não foi enviado CNPJ, buscar no Bitrix
if (!cnpjRaw) {
console.log(`[${company_id}] Buscando CNPJ no Bitrix...`);
const res = await fetch(
`${BITRIX_WEBHOOK}crm.company.get.json?id=${company_id}`
);
const data = await res.json();
cnpjRaw = data.result && data.result.UF_CRM_1588255955;

if (!cnpjRaw) {
throw new Error(
`Empresa ${company_id} não encontrada ou sem CNPJ no Bitrix`
);
}
}

// Validar CNPJ
const cnpjDigits = String(cnpjRaw).replace(/[^0-9]/g, "");
if (cnpjDigits.length !== 14) {
throw new Error(`CNPJ inválido: ${cnpjRaw}`);
}

console.log(`[${company_id}] CNPJ: ${cnpjDigits}`);
console.log(`[${company_id}] Iniciando navegador...`);

// Iniciar navegador
const browser = await chromium.launch({
args: chromiumBinary.args,
executablePath: await chromiumBinary.executablePath(),
headless: true,
});

let resultado = {
semDivida: false,
total: null,
detalhe: "",
dataConsulta: new Date().toISOString().split("T")[0],
};

try {
const page = await browser.newPage();

console.log(`[${company_id}] Acessando PGFN...`);
await page.goto("https://www.dividaaberta.pgfn.gov.br/consultar-devedores", {
waitUntil: "networkidle",
timeout: 60000,
});

// Preencher CNPJ
const cnpjMasked = cnpjDigits.replace(
/([0-9]{2})([0-9]{3})([0-9]{3})([0-9]{4})([0-9]{2})/,
"$1.$2.$3/$4-$5"
);

console.log(`[${company_id}] Preenchendo formulário com CNPJ: ${cnpjMasked}`);
await page.fill(
'input[placeholder*="000.000"], input[name*="cpf"], input[name*="cnpj"]',
cnpjMasked
);

// Clicar em "FILTRAR DEVEDORES"
await page.click('button:has-text("FILTRAR DEVEDORES")');
console.log(`[${company_id}] Aguardando resultado...`);

// Espera ATIVA por sinais de resultado (em vez de tempo fixo),
// com timeout maior para dar tempo da PGFN processar em ambiente de nuvem
try {
await page.waitForFunction(
() => {
const text = document.body.innerText || "";
return (
text.includes("Nenhum devedor encontrado") ||
text.includes("0 devedor") ||
text.includes("Detalhar") ||
/\d+\s+devedor/i.test(text)
);
},
{ timeout: 25000 }
);
} catch (waitErr) {
console.log(
`[${company_id}] Timeout aguardando sinais de resultado (25s), prosseguindo mesmo assim...`
);
}

// Pequena espera extra para garantir que a renderização terminou
await page.waitForTimeout(2000);

// Verificar resultado
const bodyText = await page.innerText("body");

if (
bodyText.includes("Nenhum devedor encontrado") ||
bodyText.includes("0 devedor")
) {
console.log(`[${company_id}] ✓ Sem dívida ativa`);
resultado.semDivida = true;
} else if (
bodyText.includes("FILTROS DE PESQUISA") &&
!bodyText.includes("Detalhar") &&
!/\d+\s+devedor/i.test(bodyText)
) {
// Ainda na tela de filtros/busca — a consulta não avançou
console.log(
`[${company_id}] ⚠ A página não avançou para os resultados (possível bloqueio ou lentidão)`
);
throw new Error(
"A consulta não retornou resultado: a página permaneceu na tela de filtros/busca (possível bloqueio de captcha ou lentidão da PGFN)."
);
} else {
console.log(`[${company_id}] Dívida encontrada, extraindo detalhes...`);
resultado.semDivida = false;

// Tentar clicar em "Detalhar"
const detalharBtn = await page.$('button:has-text("Detalhar")');
if (detalharBtn) {
await detalharBtn.click();
await page.waitForTimeout(2000);
}

// Extrair texto completo
const detalheText = await page.innerText("body");

// Tentar extrair valor total (formato: "R$ 67.128.713,47")
const totalMatch = detalheText.match(
/Total\s*R\$\s*([0-9.]+,[0-9]{2})/i
);
if (totalMatch) {
const totalStr = totalMatch[1].replace(/\./g, "").replace(",", ".");
resultado.total = parseFloat(totalStr);
console.log(`[${company_id}] Total encontrado: R$ ${totalMatch[1]}`);
}

resultado.detalhe = detalheText;
}
} finally {
await browser.close();
}

return resultado;
} catch (err) {
console.error(`[${company_id}] Erro:`, err.message);
throw err;
}
}

// Função para gravar resultado no Bitrix
async function gravarNoBitrix(company_id, resultado) {
try {
const updatePayload = {
id: company_id,
fields: {
UF_CRM_DIVIDA_ATIVA_DATA_CONSULTA: resultado.dataConsulta,
},
};

if (resultado.semDivida) {
updatePayload.fields.UF_CRM_DIVIDA_ATIVA_VALOR_BRL = 0;
updatePayload.fields.UF_CRM_DIVIDA_ATIVA_DETALHE =
"Sem dívida ativa (consultado PGFN)";
} else {
if (resultado.total !== null) {
updatePayload.fields.UF_CRM_DIVIDA_ATIVA_VALOR_BRL = resultado.total;
}
updatePayload.fields.UF_CRM_DIVIDA_ATIVA_DETALHE =
`Dívida ativa encontrada. Detalhes completos consultados em ${resultado.dataConsulta}`;
}

console.log(`[${company_id}] Gravando resultado no Bitrix...`);
const res = await fetch(`${BITRIX_WEBHOOK}crm.company.update.json`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify(updatePayload),
});

const response = await res.json();
if (response.error) {
throw new Error(`Bitrix error: ${response.error_description}`);
}

console.log(`[${company_id}] ✓ Resultado gravado com sucesso`);
return response;
} catch (err) {
console.error(`[${company_id}] Erro ao gravar:`, err.message);
throw err;
}
}

// Rota para receber webhook do Bitrix
app.post("/pgfn-consultar", async (req, res) => {
// Proteção simples por chave de API (opcional, só ativa se PGFN_API_KEY estiver configurada)
if (API_KEY) {
const sentKey = req.headers["x-api-key"] || req.query.key;
if (sentKey !== API_KEY) {
return res.status(401).json({ error: "Não autorizado. Chave de API inválida ou ausente." });
}
}

const { company_id, cnpj } = req.body;

if (!company_id) {
return res.status(400).json({ error: "company_id obrigatório" });
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`NOVA CONSULTA PGFN - Empresa ID: ${company_id}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

try {
// Consultar PGFN
const resultado = await consultarPGFN(company_id, cnpj);

// Gravar no Bitrix
await gravarNoBitrix(company_id, resultado);

// Responder ao webhook
res.json({
success: true,
company_id: company_id,
resultado: resultado,
});
} catch (err) {
console.error(`[${company_id}] FALHA:`, err.message);
res.status(500).json({
success: false,
company_id: company_id,
error: err.message,
});
}
});

// Health check
app.get("/health", (req, res) => {
res.json({ status: "ok", server: "PGFN Local Server", time: new Date() });
});

// Iniciar servidor (escuta em todas as interfaces de rede, não só localhost)
app.listen(PORT, "0.0.0.0", () => {
console.log(`\n✓ Servidor PGFN Local rodando em http://localhost:${PORT}`);
console.log(`✓ Tambem acessivel pela rede local (ex: http://192.168.x.x:${PORT})`);
console.log(`✓ Webhook pronto em: http://localhost:${PORT}/pgfn-consultar`);
console.log(`✓ Health check: http://localhost:${PORT}/health\n`);
});
