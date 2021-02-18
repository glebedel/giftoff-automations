import commander, { program } from 'commander';
import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import { parse as datefnParse } from 'date-fns';

interface CmdOptions extends commander.OptionValues {
  sessionId: string;
}

interface OrderDetails {
  purchaseDate: string | null;
  status: string | null;
  orderId: string | null;
  orderTotal: string | null;
}

interface CardInfo {
  title: string | null;
  value: string | null;
  expiry: string | null;
  url: string | null;
  detailUrl: string | null;
}

interface CardData extends OrderDetails, CardInfo {
  code: string | null;
}

type urlBuilder = (pageNumber: number) => string;

const DOMAIN = 'https://giftoff.com';
const DASHBOARD_PATH = '/dashboard';
const ARCHIVED_PATH = `${DASHBOARD_PATH}/archived`;
const VOUCHER_CODE_SELECTOR = '#voucher__code';

const getDashboardUrl = (pageNumber = 1) => `${DOMAIN}${DASHBOARD_PATH}?page=${pageNumber}`;
const getArchiveUrl = (pageNumber = 1) => `${DOMAIN}${ARCHIVED_PATH}?page=${pageNumber}`;

const CARD_WRAPPER_SELECTOR = '.dashboard__card';
const PAGINATION_MAX_SELECTOR = 'ul.pagination li:nth-last-child(2)';

const CARD_DATA_SELECTORS = {
  viewLink: 'a.dashboard__card__action.button',
  detailUrl: 'a.dashboard__card__link',
  title: '.dashboard__card__title h3[item=text-left]',
  value: '.dashboard__card__title h3.text-right',
  expiry: '.dashboard__card__date',
  status: '.order__status',
  purchaseDate: '.orders .order__details:nth-child(2) .order__detail',
  orderId: '.orders .order__details:nth-child(3) .order__detail',
  orderTotal: '.orders .order__details:nth-child(4) .order__detail',
};

const BASE_HEADERS = {
  accept: 'text/html',
  'accept-language': 'en-GB,en-US',
  'sec-ch-ua': '"Chromium";v="88", "Google Chrome";v="88", ";Not A Brand";v="99"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
  'upgrade-insecure-requests': '1',
};

const getLastPageNumber = (document: Document) => {
  const pageNbText = parseInt(document.querySelector(PAGINATION_MAX_SELECTOR)?.textContent ?? '');
  return isNaN(pageNbText) ? 1 : pageNbText;
};

const parseDate = (dateStr: string | null | undefined, stringFormat: string) => {
  if (dateStr) {
    return datefnParse(dateStr, stringFormat, Date.now()).toLocaleDateString();
  }
  return null;
};

const CARD_DETAIL_GETTER: { [key in keyof OrderDetails]: (containerElement: Element) => OrderDetails[key] } = {
  purchaseDate: (container) =>
    parseDate(container.querySelector(CARD_DATA_SELECTORS.purchaseDate)?.textContent?.trim(), 'do MMMM, yyyy'),
  status: (container) => container.querySelector(CARD_DATA_SELECTORS.status)?.textContent?.trim() ?? null,
  orderId: (container) => container.querySelector(CARD_DATA_SELECTORS.orderId)?.textContent?.trim() ?? null,
  orderTotal: (container) => container.querySelector(CARD_DATA_SELECTORS.orderTotal)?.textContent?.trim() ?? null,
};

const CARD_INFO_GETTER: { [key in keyof CardInfo]: (containerElement: Element) => CardInfo[key] } = {
  url: (container) => container.querySelector<HTMLLinkElement>(CARD_DATA_SELECTORS.viewLink)?.href ?? null,
  expiry: (container) =>
    parseDate(container.querySelector(CARD_DATA_SELECTORS.expiry)?.textContent?.match(/\: (.*)/)?.[1], 'MMMM dd, yyyy'),
  title: (container) => container.querySelector(CARD_DATA_SELECTORS.title)?.textContent?.trim() ?? null,
  value: (container) => container.querySelector(CARD_DATA_SELECTORS.value)?.textContent?.trim() ?? null,
  detailUrl: (container) => container.querySelector<HTMLLinkElement>(CARD_DATA_SELECTORS.detailUrl)?.href ?? null,
};

const getCardInfo = (container: Element) =>
  Object.entries(CARD_INFO_GETTER).reduce((cardInfo, [key, value]) => {
    cardInfo[key] = value(container);
    return cardInfo;
  }, {} as CardInfo);

const getOrderDetails = (container: Element) =>
  Object.entries(CARD_DETAIL_GETTER).reduce((cardInfo, [key, value]) => {
    cardInfo[key] = value(container);
    return cardInfo;
  }, {} as OrderDetails);

const parseTextToDoc = (pageText: string) => {
  const { document } = new JSDOM(pageText, {
    contentType: 'text/html',
    url: getDashboardUrl(),
  }).window;
  return document;
};

const authenticatedFetchPage = async (url: string, sessionId: string): Promise<Document> =>
  fetchPageDoc(url, {
    cookie: `PHPSESSID=${sessionId};`,
  });

const fetchPageDoc = async (url: string, extraHeaders: { [key: string]: string } | null = null) => {
  const result = await fetch(url, {
    headers: {
      ...BASE_HEADERS,
      ...extraHeaders,
    },
    body: undefined,
    method: 'GET',
  });
  return parseTextToDoc(await result.text());
};

const fetchCardInfos = async (urlBuilder: urlBuilder, sessionId: string): Promise<CardInfo[]> => {
  const initialDashboardDoc = await authenticatedFetchPage(urlBuilder(1), sessionId);

  const pageNumber = getLastPageNumber(initialDashboardDoc);
  let cardInfos: CardInfo[] = [];

  console.log(`Max Dashboard Pages: ${pageNumber}`);
  for (let i = 1; i <= pageNumber; i++) {
    console.log(`Fetching Dashboard Page ${i}`);
    const dashboardPageDoc = await authenticatedFetchPage(urlBuilder(i), sessionId);
    const cardContainers: Element[] = [].slice.call(dashboardPageDoc.querySelectorAll(CARD_WRAPPER_SELECTOR));
    cardInfos = [...cardInfos, ...cardContainers.map(getCardInfo)];
  }
  return cardInfos;
};

// Set-up CLI
program.version('0.0.1');
program.requiredOption('-s, --sessionId <value>', 'authentication cookie');
program.parse(process.argv);

const { sessionId } = program.opts() as CmdOptions;

const allCardInfos = [
  ...(await fetchCardInfos(getDashboardUrl, sessionId)),
  ...(await fetchCardInfos(getArchiveUrl, sessionId)),
];

const cache = {};

for (let cardInfo of allCardInfos) {
  const { url, title, expiry, value, detailUrl } = cardInfo;
  if (url) {
    const cardDoc = await fetchPageDoc(url);
    let orderDetails = {};
    if (detailUrl) {
      if (detailUrl in cache) {
        orderDetails = { ...cache[detailUrl] };
      } else {
        const orderDetailsDoc = await authenticatedFetchPage(detailUrl, sessionId);
        orderDetails = getOrderDetails(orderDetailsDoc.querySelector(CARD_WRAPPER_SELECTOR)!);
        cache[detailUrl] = { ...orderDetails };
      }
    }
    const code = cardDoc.querySelector(VOUCHER_CODE_SELECTOR)?.textContent;
    console.log(`${title};${code};${value};${expiry};${Object.values(orderDetails).join(';')}`);
  }
}
