/**
 * Posts launch alerts as a single unified Telegram message (PNG launch card +
 * HTML caption + inline buttons) to the public channel and to matching per-user
 * DM subscribers via Telegraf.
 *
 * Also handles interactive Telegram commands for personal filtering:
 *   /start         - subscribe to personal DM alerts
 *   /stop          - pause personal DM alerts
 *   /setminmc <n>  - set minimum starting market cap (in ETH)
 *   /setmaxtax <n> - set maximum buy tax percentage (0-100)
 *   /antisnipe     - toggle requiring anti-snipe protection (on/off)
 *   /setmindevbuy  - set minimum initial creator buy (in ETH)
 *   /filters       - view your current personal filter settings
 *   /resetfilters  - reset your personal filters to default (receive all)
 *   /status        - view bot runtime status & latest launch
 *   /latest        - receive the full card + alert for the most recent launch
 *   /help          - show available commands
 */
import { Input, Telegraf, TelegramError, type Context } from 'telegraf';
import { logger, errorMessage } from '../logger';
import type { Notifier, TokenGraduation, TokenLaunch, UserFilterPrefs } from '../types';
import type { LaunchWatcher } from '../chain/watcher';
import {
  DEFAULT_GRADUATION_MULTIPLIER,
  UserFilterStore,
  describeUserFilters,
  evaluateGraduatedUserFilters,
  evaluateUserFilters,
} from '../store/userFilterStore';
import {
  buildGraduatedInlineKeyboard,
  buildLaunchInlineKeyboard,
  escapeHtml,
  formatGraduatedMessage,
  formatLaunchMessage,
  formatMarketCapDisplay,
  resolveTradeUrl,
  type FormatOptions,
} from './format';
import {
  generateGraduatedCardPng,
  generateLaunchCardPng,
  uploadLaunchCardImage,
} from './imageCard';

const MAX_ATTEMPTS = 4;
/** Minimum gap between posts to stay under Telegram's rate limits. */
const MIN_POST_INTERVAL_MS = 1100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function formatUptime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function extractUserLabel(ctx: Context): string | undefined {
  const from = ctx.from;
  if (!from) return undefined;
  if (from.username) return `@${from.username}`;
  return from.first_name || undefined;
}

function formatUserFiltersMessage(prefs: UserFilterPrefs, heading = '🎯 <b>Your Personal Alert Filters</b>'): string {
  const statusStr = prefs.subscribed
    ? '🟢 <b>Subscribed</b> (receiving matching alerts via DM)'
    : '⏸ <b>Paused</b> (send /start to resume DM alerts)';
  const minMcStr = prefs.minMarketCapEth > 0 ? `<b>${prefs.minMarketCapEth} ETH</b>` : 'Any (0 ETH)';
  const maxTaxStr = prefs.maxBuyTaxPct < 100 ? `<b>${prefs.maxBuyTaxPct}%</b>` : 'Any (up to 100%)';
  const antiSnipeStr = prefs.requireAntiSnipe ? '<b>Required (On)</b>' : 'Not required (Off)';
  const minDevBuyStr = prefs.minInitialBuyEth > 0 ? `<b>${prefs.minInitialBuyEth} ETH</b>` : 'Any (0 ETH)';
  const gradStatusStr = prefs.graduatedAlerts ? '<b>Enabled (On)</b>' : 'Disabled (Off)';
  const minXStr = `<b>${prefs.minGraduatedMultiplier || DEFAULT_GRADUATION_MULTIPLIER}x</b>`;

  return [
    heading,
    '',
    `📡 <b>Status:</b> ${statusStr}`,
    '',
    '<b>New Launch Filters:</b>',
    `📊 <b>Min Market Cap:</b> ${minMcStr}`,
    `🏷 <b>Max Buy Tax:</b> ${maxTaxStr}`,
    `🛡 <b>Anti-Snipe Only:</b> ${antiSnipeStr}`,
    `💰 <b>Min Dev Buy:</b> ${minDevBuyStr}`,
    '',
    '<b>Graduated / Launch Complete Filters:</b>',
    `🎓 <b>Graduated Alerts:</b> ${gradStatusStr}`,
    `🚀 <b>Min Multiple (X):</b> ${minXStr}`,
    '',
    '<b>Quick Commands:</b>',
    '• <code>/setminmc 1.5</code> — only alert if MCap ≥ 1.5 ETH',
    '• <code>/setmaxtax 3</code> — only alert if Buy Tax ≤ 3%',
    '• <code>/antisnipe on</code> — only alert if anti-snipe is enabled',
    '• <code>/setmindevbuy 0.02</code> — only alert if Dev Buy ≥ 0.02 ETH',
    '• <code>/graduated on|off</code> — enable or disable graduated alerts',
    '• <code>/setminx 10</code> — only alert on graduated tokens ≥ 10x',
    '• <code>/resetfilters</code> — reset all filters (receive everything)',
  ].join('\n');
}

export interface TelegramNotifierOptions extends FormatOptions {
  postToChannel?: boolean;
  /**
   * When true (default), posts the text alert to the public channel immediately
   * after detection (0ms wait on image generation/upload) and sends the PNG
   * launch card + subscriber DMs as non-blocking follow-up tasks.
   */
  fastChannelTextFirst?: boolean;
  userStore?: UserFilterStore;
}

interface PreparedLaunchPayload {
  pngBuffer: Buffer | null;
  filename: string;
  caption: string;
  inlineKeyboard: { text: string; url: string }[][];
}

export class TelegramNotifier implements Notifier {
  private readonly bot: Telegraf;
  private readonly postToChannel: boolean;
  private readonly userStore?: UserFilterStore;
  private lastPostAt = 0;
  private commandsLaunched = false;
  private readonly pendingTasks = new Set<Promise<void>>();

  constructor(
    token: string,
    private readonly channelId: string,
    private readonly formatOptions: TelegramNotifierOptions = {},
  ) {
    this.bot = new Telegraf(token);
    this.postToChannel = formatOptions.postToChannel ?? Boolean(channelId);
    this.userStore = formatOptions.userStore;
  }

  /** Checks the token is valid and (when channel posting is enabled) the bot can see the channel. */
  async verify(): Promise<void> {
    const me = await this.bot.telegram.getMe();
    logger.info(`Telegram bot authenticated as @${me.username}`);
    if (this.postToChannel && this.channelId) {
      try {
        const chat = await this.bot.telegram.getChat(this.channelId);
        const title = 'title' in chat ? chat.title : this.channelId;
        logger.info(`Posting to Telegram channel "${title}" (${chat.id})`);
      } catch (err) {
        throw new Error(
          `Bot cannot access TELEGRAM_CHANNEL_ID=${this.channelId}. ` +
            `Make sure the bot is an admin of the channel. (${errorMessage(err)})`,
        );
      }
    } else {
      logger.info('Public channel posting disabled; sending alerts to subscribed DM users only');
    }
  }

  /**
   * Dispatches a newly detected launch as ONE single unified Telegram message
   * (1200x675 PNG launch card + full HTML caption + inline buttons):
   *   1. Renders the PNG card locally in memory (~50ms) and immediately sends the
   *      unified photo+caption message to the public channel (zero wait on external
   *      catbox.moe image upload).
   *   2. In the background, uploads the PNG to catbox.moe (updating the channel
   *      message's Share buttons) and dispatches the unified alert (reusing Telegram's
   *      `file_id`) to matching DM subscribers.
   */
  async postLaunch(launch: TokenLaunch): Promise<void> {
    const postStartMs = Date.now();
    const filename = `torch-${(launch.symbol ?? 'launch').toLowerCase()}-${launch.address.slice(-6)}.png`;
    let pngBuffer: Buffer | null = null;
    let renderMs = 0;

    if (this.formatOptions.includeImageCard !== false) {
      const renderStart = Date.now();
      try {
        pngBuffer = await generateLaunchCardPng(launch);
        renderMs = Date.now() - renderStart;
      } catch (err) {
        logger.warn(
          `Image card generation failed for ${launch.address} (${errorMessage(err)}); falling back to text alert`,
        );
      }
    }

    const caption = formatLaunchMessage(launch, this.formatOptions);
    const initialKeyboard = buildLaunchInlineKeyboard(launch, this.formatOptions);
    const initialPayload: PreparedLaunchPayload = {
      pngBuffer,
      filename,
      caption,
      inlineKeyboard: initialKeyboard,
    };

    let cachedPhotoFileId: string | null = null;
    let channelMessageId: number | null = null;

    if (this.postToChannel && this.channelId) {
      const delivered = await this.deliverChannelUnifiedImmediate(
        this.channelId,
        initialPayload,
      );
      cachedPhotoFileId = delivered.fileId;
      channelMessageId = delivered.messageId;

      const channelSentAtMs = Date.now();
      this.lastPostAt = channelSentAtMs;

      const onChainIso = new Date(launch.timestamp * 1000).toISOString();
      const receivedIso = launch.detectedAtMs
        ? new Date(launch.detectedAtMs).toISOString()
        : new Date(postStartMs).toISOString();
      const sentIso = new Date(channelSentAtMs).toISOString();
      const enrichMs =
        launch.detectedAtMs && launch.enrichedAtMs
          ? launch.enrichedAtMs - launch.detectedAtMs
          : 0;
      const tgSendMs = channelSentAtMs - postStartMs - renderMs;
      const eventToChannelMs = launch.detectedAtMs
        ? channelSentAtMs - launch.detectedAtMs
        : channelSentAtMs - postStartMs;
      const totalFromChainMs = channelSentAtMs - launch.timestamp * 1000;

      logger.info(
        `[CHANNEL-POSTED] $${launch.symbol ?? '?'} (${launch.name ?? '?'}) CA=${launch.address} ` +
          `mcap=${formatMarketCapDisplay(launch) ?? '?'} tax=${launch.buyTaxPct ?? '?'}% -> ${this.channelId} | ` +
          `onChain=${onChainIso} eventReceived=${receivedIso} channelSent=${sentIso} | ` +
          `eventToChannel=${eventToChannelMs}ms (enrich=${enrichMs}ms, render=${renderMs}ms, tgSend=${tgSendMs}ms, totalFromChain=${totalFromChainMs}ms)`,
      );
    }

    // Run external share-host upload + subscriber DMs in the background so the watcher never stalls.
    this.trackBackgroundTask(
      this.finishShareUploadAndDms(
        launch,
        initialPayload,
        cachedPhotoFileId,
        channelMessageId,
      ).catch((err) =>
        logger.error(`Background DM/share task failed for ${launch.address}: ${errorMessage(err)}`),
      ),
    );
  }

  /**
   * Sends the unified single-message alert (PNG card + HTML caption + inline buttons)
   * to the public channel immediately without waiting for inter-post throttling.
   */
  private async deliverChannelUnifiedImmediate(
    chatId: string | number,
    payload: PreparedLaunchPayload,
  ): Promise<{ fileId: string | null; messageId: number | null }> {
    if (payload.pngBuffer) {
      try {
        const msg = await this.bot.telegram.sendPhoto(
          chatId,
          Input.fromBuffer(payload.pngBuffer, payload.filename),
          {
            caption: payload.caption,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: payload.inlineKeyboard },
          },
        );
        return {
          fileId: msg.photo?.at(-1)?.file_id ?? null,
          messageId: msg.message_id,
        };
      } catch (err) {
        logger.warn(
          `Immediate sendPhoto failed for channel ${chatId} (${errorMessage(err)}); falling back to withRetry`,
        );
        try {
          const msg = await this.withRetry(() =>
            this.bot.telegram.sendPhoto(
              chatId,
              Input.fromBuffer(payload.pngBuffer!, payload.filename),
              {
                caption: payload.caption,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: payload.inlineKeyboard },
              },
            ),
          );
          return {
            fileId: msg.photo?.at(-1)?.file_id ?? null,
            messageId: msg.message_id,
          };
        } catch (retryErr) {
          logger.warn(
            `sendPhoto retry failed for channel ${chatId} (${errorMessage(retryErr)}); falling back to sendMessage`,
          );
        }
      }
    }

    const msgId = await this.sendChannelTextImmediate(
      chatId,
      payload.caption,
      payload.inlineKeyboard,
    );
    return { fileId: null, messageId: msgId };
  }

  /**
   * Uploads the PNG card to catbox.moe in the background (so X/TG share links embed
   * the card image), updates the channel post's share buttons, and dispatches the
   * single unified message to matching DM subscribers.
   */
  private async finishShareUploadAndDms(
    launch: TokenLaunch,
    basePayload: PreparedLaunchPayload,
    cachedPhotoFileId: string | null,
    channelMessageId: number | null,
  ): Promise<void> {
    const uploadPromise = basePayload.pngBuffer
      ? uploadLaunchCardImage(basePayload.pngBuffer)
      : Promise.resolve(null);

    // Dispatch to DM subscribers immediately using Telegram's cached file_id
    await this.dispatchToSubscribers(launch, basePayload, cachedPhotoFileId);

    const cardImageUrl = await uploadPromise;
    if (cardImageUrl && this.postToChannel && this.channelId && channelMessageId) {
      const updatedKeyboard = buildLaunchInlineKeyboard(launch, {
        ...this.formatOptions,
        cardImageUrl,
      });
      void this.bot.telegram
        .editMessageReplyMarkup(this.channelId, channelMessageId, undefined, {
          inline_keyboard: updatedKeyboard,
        })
        .catch(() => {
          // Ignore if markup was unchanged or couldn't be edited
        });
    }
  }

  /**
   * Dispatches a "Launch Complete" / Graduated (~10x) alert to:
   *   1. The public Telegram channel (when `graduation.isFirstChannelGraduation` is true)
   *   2. Every subscribed user whose graduation filters match (`graduatedAlerts=true` and
   *      `multiple >= minGraduatedMultiplier`) and who has not yet been notified for this token.
   * Returns the array of user `chatId`s that were notified during this call.
   */
  async postGraduation(graduation: TokenGraduation): Promise<number[]> {
    const filename = `torch-graduated-${(graduation.symbol ?? 'token').toLowerCase()}-${graduation.address.slice(-6)}.png`;
    let pngBuffer: Buffer | null = null;
    let cardImageUrl: string | null = null;

    if (this.formatOptions.includeImageCard !== false) {
      try {
        pngBuffer = await generateGraduatedCardPng(graduation);
      } catch (err) {
        logger.warn(
          `Graduated card generation failed for ${graduation.address} (${errorMessage(err)}); falling back to text alert`,
        );
      }
    }

    const optsWithCard: FormatOptions = {
      ...this.formatOptions,
      cardImageUrl,
    };

    const payload: PreparedLaunchPayload = {
      pngBuffer,
      filename,
      caption: formatGraduatedMessage(graduation, optsWithCard),
      inlineKeyboard: buildGraduatedInlineKeyboard(graduation, optsWithCard),
    };

    let cachedPhotoFileId: string | null = null;

    // 1. Post to public channel once when the token first crosses the global ~10x graduation mark
    if (graduation.isFirstChannelGraduation && this.postToChannel && this.channelId) {
      cachedPhotoFileId = await this.deliverPayload(this.channelId, payload, cachedPhotoFileId);
      logger.info(
        `[GRADUATED-CHANNEL-POSTED] $${graduation.symbol ?? '?'} (${graduation.name ?? '?'}) CA=${graduation.address} ` +
          `multiple=${graduation.multiple.toFixed(2)}x mcap=${graduation.currentMarketCapQuote.toFixed(2)} ${graduation.quoteSymbol} -> ${this.channelId}`,
      );
    }

    // 2. Check each subscribed user's graduation preferences (/graduated, /setminx)
    const subscribers = this.userStore?.getSubscribedUsers() ?? [];
    const notifiedNow: number[] = [];
    if (subscribers.length === 0) return notifiedNow;

    let filteredCount = 0;
    for (const prefs of subscribers) {
      if (graduation.alreadyNotifiedUserIds.has(prefs.chatId)) {
        continue;
      }

      const userLabel = prefs.username ? `${prefs.username} (${prefs.chatId})` : String(prefs.chatId);
      const filterReason = evaluateGraduatedUserFilters(graduation, prefs);

      if (filterReason !== null) {
        filteredCount++;
        logger.info(
          `[GRADUATED-USER-FILTERED] Skipped $${graduation.symbol ?? '?'} (${graduation.multiple.toFixed(1)}x) for user ${userLabel}: ${filterReason}`,
        );
        continue;
      }

      try {
        cachedPhotoFileId = await this.deliverPayload(prefs.chatId, payload, cachedPhotoFileId);
        notifiedNow.push(prefs.chatId);
        logger.info(
          `[GRADUATED-USER-SENT] Sent $${graduation.symbol ?? '?'} (${graduation.multiple.toFixed(1)}x) to user ${userLabel} [minX=${prefs.minGraduatedMultiplier}x]`,
        );
      } catch (err) {
        if (
          err instanceof TelegramError &&
          (err.code === 403 || /chat not found|user is deactivated|bot was blocked/i.test(err.message))
        ) {
          logger.warn(
            `User ${userLabel} blocked the bot or chat is unreachable (${err.message}); unsubscribing user`,
          );
          await this.userStore?.update(prefs.chatId, { subscribed: false });
        } else {
          logger.error(`Failed to send graduated DM alert to user ${userLabel}: ${errorMessage(err)}`);
        }
      }
    }

    logger.info(
      `[GRADUATED-USER-DISPATCH] $${graduation.symbol ?? '?'} (${graduation.multiple.toFixed(1)}x): sent to ${notifiedNow.length} subscriber(s) (${filteredCount} filtered out)`,
    );
    return notifiedNow;
  }

  /** Waits for any in-flight follow-up card/DM tasks to finish (used on shutdown & test scripts). */
  async flushPendingTasks(): Promise<void> {
    if (this.pendingTasks.size === 0) return;
    await Promise.allSettled([...this.pendingTasks]);
  }

  private trackBackgroundTask(task: Promise<void>): void {
    this.pendingTasks.add(task);
    void task.finally(() => {
      this.pendingTasks.delete(task);
    });
  }

  /**
   * Sends the urgent first text alert to the public channel immediately,
   * without waiting for inter-post throttling or image rendering.
   */
  private async sendChannelTextImmediate(
    chatId: string | number,
    caption: string,
    inlineKeyboard: { text: string; url: string }[][],
  ): Promise<number | null> {
    try {
      const msg = await this.bot.telegram.sendMessage(chatId, caption, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
      return msg.message_id;
    } catch (err) {
      if (err instanceof TelegramError && /can't parse entities/i.test(err.message)) {
        const plainText = caption
          .replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
        const msg = await this.bot.telegram.sendMessage(chatId, plainText, {
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: inlineKeyboard },
        });
        return msg.message_id;
      }
      // Fall back to retry helper on rate-limit (429) or transient network error
      const msg = await this.withRetry(() =>
        this.bot.telegram.sendMessage(chatId, caption, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: inlineKeyboard },
        }),
      );
      return msg.message_id;
    }
  }

  /** Evaluates each subscribed user's personal filters and sends DMs to matching users. */
  private async dispatchToSubscribers(
    launch: TokenLaunch,
    payload: PreparedLaunchPayload,
    cachedPhotoFileId: string | null,
  ): Promise<void> {
    const subscribers = this.userStore?.getSubscribedUsers() ?? [];
    if (subscribers.length === 0) return;

    let matchedCount = 0;
    let filteredCount = 0;

    for (const prefs of subscribers) {
      const userLabel = prefs.username ? `${prefs.username} (${prefs.chatId})` : String(prefs.chatId);
      const filterReason = evaluateUserFilters(launch, prefs);

      if (filterReason !== null) {
        filteredCount++;
        logger.info(
          `[USER-FILTERED] Skipped $${launch.symbol ?? '?'} for user ${userLabel}: ${filterReason}`,
        );
        continue;
      }

      try {
        cachedPhotoFileId = await this.deliverPayload(prefs.chatId, payload, cachedPhotoFileId);
        matchedCount++;
        logger.info(
          `[USER-SENT] Sent $${launch.symbol ?? '?'} to user ${userLabel} [${describeUserFilters(prefs)}]`,
        );
      } catch (err) {
        if (
          err instanceof TelegramError &&
          (err.code === 403 || /chat not found|user is deactivated|bot was blocked/i.test(err.message))
        ) {
          logger.warn(
            `User ${userLabel} blocked the bot or chat is unreachable (${err.message}); unsubscribing user`,
          );
          await this.userStore?.update(prefs.chatId, { subscribed: false });
        } else {
          logger.error(`Failed to send DM alert to user ${userLabel}: ${errorMessage(err)}`);
        }
      }
    }

    logger.info(
      `[USER-DISPATCH] $${launch.symbol ?? '?'}: sent to ${matchedCount}/${subscribers.length} subscriber(s) (${filteredCount} filtered out)`,
    );
  }

  /** Renders the PNG card, uploads it once for X/TG share links, and builds the caption + buttons. */
  private async preparePayload(launch: TokenLaunch): Promise<PreparedLaunchPayload> {
    const filename = `torch-${(launch.symbol ?? 'launch').toLowerCase()}-${launch.address.slice(-6)}.png`;
    let pngBuffer: Buffer | null = null;
    let cardImageUrl: string | null = null;

    if (this.formatOptions.includeImageCard !== false) {
      try {
        pngBuffer = await generateLaunchCardPng(launch);
        cardImageUrl = await uploadLaunchCardImage(pngBuffer);
      } catch (err) {
        logger.warn(
          `Image card generation failed for ${launch.address} (${errorMessage(err)}); falling back to text alert`,
        );
      }
    }

    const optsWithCard: FormatOptions = {
      ...this.formatOptions,
      cardImageUrl,
    };

    return {
      pngBuffer,
      filename,
      caption: formatLaunchMessage(launch, optsWithCard),
      inlineKeyboard: buildLaunchInlineKeyboard(launch, optsWithCard),
    };
  }

  /**
   * Sends a prepared launch payload to a single chatId.
   * If Telegram has already assigned a `file_id` for the photo on the first send,
   * reuses `file_id` so subsequent per-user DMs don't re-upload the PNG buffer.
   */
  private async deliverPayload(
    chatId: string | number,
    payload: PreparedLaunchPayload,
    existingFileId: string | null,
  ): Promise<string | null> {
    if (payload.pngBuffer) {
      try {
        const photoInput = existingFileId
          ? existingFileId
          : Input.fromBuffer(payload.pngBuffer, payload.filename);
        const msg = await this.withRetry(() =>
          this.bot.telegram.sendPhoto(chatId, photoInput, {
            caption: payload.caption,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: payload.inlineKeyboard },
          }),
        );
        const largestPhoto = msg.photo?.at(-1);
        return largestPhoto?.file_id ?? existingFileId;
      } catch (err) {
        logger.warn(
          `sendPhoto failed for chat ${chatId} (${errorMessage(err)}); falling back to sendMessage`,
        );
      }
    }

    try {
      await this.withRetry(() =>
        this.bot.telegram.sendMessage(chatId, payload.caption, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: payload.inlineKeyboard },
        }),
      );
    } catch (err) {
      if (err instanceof TelegramError && /can't parse entities/i.test(err.message)) {
        const plainText = payload.caption
          .replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
        await this.withRetry(() =>
          this.bot.telegram.sendMessage(chatId, plainText, {
            link_preview_options: { is_disabled: true },
            reply_markup: { inline_keyboard: payload.inlineKeyboard },
          }),
        );
      } else {
        throw err;
      }
    }
    return existingFileId;
  }

  /** Sends a launch alert to a single chat (used by `/latest`). */
  private async sendLaunchToChat(chatId: string | number, launch: TokenLaunch): Promise<void> {
    const payload = await this.preparePayload(launch);
    await this.deliverPayload(chatId, payload, null);
  }

  /**
   * Registers and starts interactive Telegram bot commands for personal filtering
   * and bot status inspection.
   */
  async startCommandListener(watcher: LaunchWatcher): Promise<void> {
    if (this.commandsLaunched) return;

    // /start — Subscribe user & show welcome + personal filter settings
    this.bot.command('start', async (ctx) => {
      try {
        const label = extractUserLabel(ctx);
        const prefs = this.userStore
          ? await this.userStore.update(ctx.chat.id, { subscribed: true }, label)
          : null;
        logger.info(`[USER-CMD] /start from ${label ?? ctx.chat.id} (chatId=${ctx.chat.id})`);

        const welcome = [
          '🔥 <b>Welcome to Torch Launchpad Alerts!</b>',
          '',
          'You are now subscribed to receive real-time Torch token launch alerts directly in this chat.',
          'By default, you receive <b>all</b> verified Torch launches (<code>…1111</code>). You can customize your personal filters below so you only get alerted on launches matching your criteria:',
          '',
          prefs ? formatUserFiltersMessage(prefs) : '',
        ].join('\n');

        await ctx.reply(welcome, { parse_mode: 'HTML' });
      } catch (err) {
        logger.warn(`/start err: ${errorMessage(err)}`);
      }
    });

    // /stop or /unsubscribe — Pause personal DM alerts
    this.bot.command(['stop', 'unsubscribe'], async (ctx) => {
      try {
        const label = extractUserLabel(ctx);
        if (this.userStore) {
          await this.userStore.update(ctx.chat.id, { subscribed: false }, label);
        }
        logger.info(`[USER-CMD] /stop from ${label ?? ctx.chat.id} (chatId=${ctx.chat.id})`);
        await ctx.reply(
          '⏸ <b>Personal DM alerts paused.</b>\nYour filter preferences are saved. Send /start anytime to resume alerts.',
          { parse_mode: 'HTML' },
        );
      } catch (err) {
        logger.warn(`/stop err: ${errorMessage(err)}`);
      }
    });

    // /setminmc <value> — Set minimum starting market cap in ETH
    this.bot.command('setminmc', async (ctx) => {
      try {
        if (!this.userStore) {
          await ctx.reply('User filter store is not enabled.');
          return;
        }
        const arg = ctx.message.text.split(/\s+/)[1]?.trim().replace(/^[$]/, '');
        const value = arg !== undefined && arg !== '' ? Number(arg) : Number.NaN;

        if (!Number.isFinite(value) || value < 0) {
          await ctx.reply(
            '⚠️ <b>Usage:</b> <code>/setminmc &lt;eth_amount&gt;</code>\n\n' +
              '<b>Examples:</b>\n' +
              '• <code>/setminmc 1.5</code> — only alert on launches with starting MCap ≥ 1.5 ETH\n' +
              '• <code>/setminmc 0</code> — disable minimum MCap filter',
            { parse_mode: 'HTML' },
          );
          return;
        }

        const label = extractUserLabel(ctx);
        const prefs = await this.userStore.update(
          ctx.chat.id,
          { minMarketCapEth: value },
          label,
        );
        logger.info(
          `[USER-CONFIG] User ${label ?? ctx.chat.id} (${ctx.chat.id}) set minMarketCapEth=${value} ETH`,
        );

        const confirmHeading =
          value > 0
            ? `✅ <b>Minimum Market Cap set to ${value} ETH</b>`
            : '✅ <b>Minimum Market Cap filter disabled (0 ETH)</b>';
        await ctx.reply(formatUserFiltersMessage(prefs, confirmHeading), { parse_mode: 'HTML' });
      } catch (err) {
        logger.warn(`/setminmc err: ${errorMessage(err)}`);
      }
    });

    // /setmaxtax <value> — Set maximum buy tax percentage
    this.bot.command('setmaxtax', async (ctx) => {
      try {
        if (!this.userStore) {
          await ctx.reply('User filter store is not enabled.');
          return;
        }
        const arg = ctx.message.text.split(/\s+/)[1]?.trim().replace(/%$/, '');
        const value = arg !== undefined && arg !== '' ? Number(arg) : Number.NaN;

        if (!Number.isFinite(value) || value < 0 || value > 100) {
          await ctx.reply(
            '⚠️ <b>Usage:</b> <code>/setmaxtax &lt;percentage&gt;</code> (0–100)\n\n' +
              '<b>Examples:</b>\n' +
              '• <code>/setmaxtax 3</code> — only alert on launches with Buy Tax ≤ 3%\n' +
              '• <code>/setmaxtax 0</code> — only alert on 0% buy tax tokens\n' +
              '• <code>/setmaxtax 100</code> — allow any buy tax',
            { parse_mode: 'HTML' },
          );
          return;
        }

        const label = extractUserLabel(ctx);
        const prefs = await this.userStore.update(
          ctx.chat.id,
          { maxBuyTaxPct: value },
          label,
        );
        logger.info(
          `[USER-CONFIG] User ${label ?? ctx.chat.id} (${ctx.chat.id}) set maxBuyTaxPct=${value}%`,
        );

        const confirmHeading =
          value < 100
            ? `✅ <b>Maximum Buy Tax set to ${value}%</b>`
            : '✅ <b>Maximum Buy Tax filter disabled (up to 100%)</b>';
        await ctx.reply(formatUserFiltersMessage(prefs, confirmHeading), { parse_mode: 'HTML' });
      } catch (err) {
        logger.warn(`/setmaxtax err: ${errorMessage(err)}`);
      }
    });

    // /antisnipe [on|off] — Only alert on launches with anti-snipe enabled
    this.bot.command('antisnipe', async (ctx) => {
      try {
        if (!this.userStore) {
          await ctx.reply('User filter store is not enabled.');
          return;
        }
        const label = extractUserLabel(ctx);
        const current = await this.userStore.getOrCreate(ctx.chat.id, label);
        const arg = ctx.message.text.split(/\s+/)[1]?.trim().toLowerCase();

        let nextVal: boolean;
        if (!arg) {
          nextVal = !current.requireAntiSnipe;
        } else if (['on', 'true', 'yes', '1'].includes(arg)) {
          nextVal = true;
        } else if (['off', 'false', 'no', '0'].includes(arg)) {
          nextVal = false;
        } else {
          await ctx.reply(
            '⚠️ <b>Usage:</b> <code>/antisnipe on</code> or <code>/antisnipe off</code>',
            { parse_mode: 'HTML' },
          );
          return;
        }

        const prefs = await this.userStore.update(
          ctx.chat.id,
          { requireAntiSnipe: nextVal },
          label,
        );
        logger.info(
          `[USER-CONFIG] User ${label ?? ctx.chat.id} (${ctx.chat.id}) set requireAntiSnipe=${nextVal}`,
        );

        const confirmHeading = nextVal
          ? '✅ <b>Anti-Snipe filter enabled (only alerting on tokens with anti-snipe)</b>'
          : '✅ <b>Anti-Snipe filter disabled (alerting on all tokens)</b>';
        await ctx.reply(formatUserFiltersMessage(prefs, confirmHeading), { parse_mode: 'HTML' });
      } catch (err) {
        logger.warn(`/antisnipe err: ${errorMessage(err)}`);
      }
    });

    // /setmindevbuy <value> — Set minimum initial creator buy in ETH
    this.bot.command('setmindevbuy', async (ctx) => {
      try {
        if (!this.userStore) {
          await ctx.reply('User filter store is not enabled.');
          return;
        }
        const arg = ctx.message.text.split(/\s+/)[1]?.trim();
        const value = arg !== undefined && arg !== '' ? Number(arg) : Number.NaN;

        if (!Number.isFinite(value) || value < 0) {
          await ctx.reply(
            '⚠️ <b>Usage:</b> <code>/setmindevbuy &lt;eth_amount&gt;</code>\n\n' +
              '<b>Examples:</b>\n' +
              '• <code>/setmindevbuy 0.02</code> — only alert when creator buys ≥ 0.02 ETH at launch\n' +
              '• <code>/setmindevbuy 0</code> — allow 0-buy launches',
            { parse_mode: 'HTML' },
          );
          return;
        }

        const label = extractUserLabel(ctx);
        const prefs = await this.userStore.update(
          ctx.chat.id,
          { minInitialBuyEth: value },
          label,
        );
        logger.info(
          `[USER-CONFIG] User ${label ?? ctx.chat.id} (${ctx.chat.id}) set minInitialBuyEth=${value} ETH`,
        );

        const confirmHeading =
          value > 0
            ? `✅ <b>Minimum Dev Buy set to ${value} ETH</b>`
            : '✅ <b>Minimum Dev Buy filter disabled (0 ETH)</b>';
        await ctx.reply(formatUserFiltersMessage(prefs, confirmHeading), { parse_mode: 'HTML' });
      } catch (err) {
        logger.warn(`/setmindevbuy err: ${errorMessage(err)}`);
      }
    });

    // /graduated [on|off] — Enable or disable Graduated / "Launch Complete" (~10x) alerts
    this.bot.command('graduated', async (ctx) => {
      try {
        if (!this.userStore) {
          await ctx.reply('User filter store is not enabled.');
          return;
        }
        const label = extractUserLabel(ctx);
        const current = await this.userStore.getOrCreate(ctx.chat.id, label);
        const arg = ctx.message.text.split(/\s+/)[1]?.trim().toLowerCase();

        let nextVal: boolean;
        if (!arg) {
          nextVal = !current.graduatedAlerts;
        } else if (['on', 'true', 'yes', '1', 'enable', 'enabled'].includes(arg)) {
          nextVal = true;
        } else if (['off', 'false', 'no', '0', 'disable', 'disabled'].includes(arg)) {
          nextVal = false;
        } else {
          await ctx.reply(
            '⚠️ <b>Usage:</b> <code>/graduated on</code> or <code>/graduated off</code>\n\n' +
              '<b>Examples:</b>\n' +
              '• <code>/graduated on</code> — receive alerts when Torch tokens reach the ~10x "Launch Complete" milestone\n' +
              '• <code>/graduated off</code> — disable graduated alerts',
            { parse_mode: 'HTML' },
          );
          return;
        }

        const prefs = await this.userStore.update(
          ctx.chat.id,
          { graduatedAlerts: nextVal },
          label,
        );
        logger.info(
          `[USER-CONFIG] User ${label ?? ctx.chat.id} (${ctx.chat.id}) set graduatedAlerts=${nextVal}`,
        );

        const confirmHeading = nextVal
          ? `✅ <b>Graduated ("Launch Complete") Alerts Enabled (≥ ${prefs.minGraduatedMultiplier}x)</b>`
          : '⏸ <b>Graduated ("Launch Complete") Alerts Disabled</b>';
        await ctx.reply(formatUserFiltersMessage(prefs, confirmHeading), { parse_mode: 'HTML' });
      } catch (err) {
        logger.warn(`/graduated err: ${errorMessage(err)}`);
      }
    });

    // /setminx <number> — Set minimum multiple from launch for graduated alerts (e.g. 10)
    this.bot.command('setminx', async (ctx) => {
      try {
        if (!this.userStore) {
          await ctx.reply('User filter store is not enabled.');
          return;
        }
        const arg = ctx.message.text.split(/\s+/)[1]?.trim().toLowerCase().replace(/x$/, '');
        const value = arg !== undefined && arg !== '' ? Number(arg) : Number.NaN;

        if (!Number.isFinite(value) || value < 1.1 || value > 10_000) {
          await ctx.reply(
            '⚠️ <b>Usage:</b> <code>/setminx &lt;multiple&gt;</code> (e.g. <code>10</code> for 10x)\n\n' +
              '<b>Examples:</b>\n' +
              '• <code>/setminx 10</code> — alert when a token reaches ≥ 10x starting market cap (Launch Complete)\n' +
              '• <code>/setminx 15</code> — only alert when a token reaches ≥ 15x starting market cap',
            { parse_mode: 'HTML' },
          );
          return;
        }

        const label = extractUserLabel(ctx);
        const prefs = await this.userStore.update(
          ctx.chat.id,
          { minGraduatedMultiplier: value, graduatedAlerts: true },
          label,
        );
        logger.info(
          `[USER-CONFIG] User ${label ?? ctx.chat.id} (${ctx.chat.id}) set minGraduatedMultiplier=${value}x`,
        );

        const confirmHeading = `✅ <b>Minimum Graduation Multiple set to ${value}x</b>`;
        await ctx.reply(formatUserFiltersMessage(prefs, confirmHeading), { parse_mode: 'HTML' });
      } catch (err) {
        logger.warn(`/setminx err: ${errorMessage(err)}`);
      }
    });

    // /filters — Show the user's current filter settings
    this.bot.command('filters', async (ctx) => {
      try {
        if (!this.userStore) {
          const s = watcher.getStatus();
          await ctx.reply(
            `🎯 <b>Global Launch Filters:</b> <code>${escapeHtml(s.activeFiltersSummary)}</code>`,
            { parse_mode: 'HTML' },
          );
          return;
        }
        const label = extractUserLabel(ctx);
        const prefs = await this.userStore.getOrCreate(ctx.chat.id, label);
        logger.info(`[USER-CMD] /filters from ${label ?? ctx.chat.id} (${describeUserFilters(prefs)})`);
        await ctx.reply(formatUserFiltersMessage(prefs), { parse_mode: 'HTML' });
      } catch (err) {
        logger.warn(`/filters err: ${errorMessage(err)}`);
      }
    });

    // /resetfilters — Reset user's filters to default (receive everything)
    this.bot.command('resetfilters', async (ctx) => {
      try {
        if (!this.userStore) {
          await ctx.reply('User filter store is not enabled.');
          return;
        }
        const label = extractUserLabel(ctx);
        const prefs = await this.userStore.reset(ctx.chat.id, label);
        logger.info(
          `[USER-CONFIG] User ${label ?? ctx.chat.id} (${ctx.chat.id}) reset filters to default`,
        );
        await ctx.reply(
          formatUserFiltersMessage(
            prefs,
            '🔄 <b>Filters Reset to Default (Receiving All Launches)</b>',
          ),
          { parse_mode: 'HTML' },
        );
      } catch (err) {
        logger.warn(`/resetfilters err: ${errorMessage(err)}`);
      }
    });

    const replyStatus = async (chatId: number | string) => {
      const s = watcher.getStatus();
      const latest = s.lastLaunch ?? (await watcher.findLatestLaunchOnChain().catch(() => null));
      const uptime = formatUptime(Date.now() - s.startedAtMs);
      const subCount = this.userStore?.subscriberCount ?? 0;

      const lines = [
        `🟢 <b>Torch Alerts Bot — Running</b>`,
        '',
        `⏱ <b>Uptime:</b> ${uptime}`,
        `📦 <b>Last Scanned Block:</b> <code>${s.lastBlock ?? 'initializing'}</code>`,
        `🔔 <b>Alerts Sent (Session / Total Seen):</b> ${s.postedThisSession} / ${s.seenCount}`,
        `🎓 <b>Graduation Tracker:</b> ${s.trackedCount} tracked (${s.graduatedCount} graduated)`,
        `👥 <b>DM Subscribers:</b> ${subCount}`,
        `🎯 <b>Global Channel Filters:</b> ${escapeHtml(s.activeFiltersSummary)}`,
      ];

      if (latest) {
        const tradeUrl = resolveTradeUrl(latest.address, this.formatOptions.tokenUrlTemplate);
        const ticker = latest.symbol ? `$${escapeHtml(latest.symbol)}` : '<i>Unknown</i>';
        const name = latest.name ? escapeHtml(latest.name) : 'Unknown';
        const mcap = escapeHtml(formatMarketCapDisplay(latest) ?? 'n/a');
        lines.push(
          '',
          `🔥 <b>Latest Launch:</b> <b>${ticker}</b> (${name})`,
          `📋 <b>CA:</b> <code>${escapeHtml(latest.address)}</code>`,
          `📊 <b>MCap:</b> ${mcap}  ·  <b>Tax:</b> ${latest.buyTaxPct ?? 0}% Buy`,
          `🚀 <a href="${escapeHtml(tradeUrl)}">Trade on Torch</a>`,
        );
      } else {
        lines.push('', '<i>No launches found in recent blocks.</i>');
      }

      await this.bot.telegram.sendMessage(chatId, lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    };

    const replyLatest = async (chatId: number | string) => {
      const latest = await watcher.findLatestLaunchOnChain();
      if (!latest) {
        await this.bot.telegram.sendMessage(chatId, 'No recent Torch launch found on-chain.');
        return;
      }
      await this.sendLaunchToChat(chatId, latest);
    };

    const replyHelp = async (chatId: number | string) => {
      const text = [
        '🔥 <b>Torch Launchpad Alerts Bot</b>',
        '',
        '<b>New Launch Filter Commands (DM the bot):</b>',
        '• <code>/setminmc &lt;value&gt;</code> — Set minimum starting market cap in ETH (e.g. <code>/setminmc 1.5</code>)',
        '• <code>/setmaxtax &lt;value&gt;</code> — Set maximum buy tax % (e.g. <code>/setmaxtax 3</code>)',
        '• <code>/antisnipe [on|off]</code> — Only alert on launches with anti-snipe enabled',
        '• <code>/setmindevbuy &lt;value&gt;</code> — Set minimum initial dev buy in ETH (e.g. <code>/setmindevbuy 0.02</code>)',
        '',
        '<b>Graduated / Launch Complete (~10x) Commands:</b>',
        '• <code>/graduated on|off</code> — Enable or disable graduated ("Launch Complete") alerts',
        '• <code>/setminx &lt;number&gt;</code> — Only alert if the multiple is at least this value (e.g. <code>/setminx 10</code>)',
        '',
        '<b>Manage &amp; Inspect:</b>',
        '• <code>/filters</code> — Show your current filter settings',
        '• <code>/resetfilters</code> — Reset your filters to default (receive everything)',
        '• <code>/start</code> — Subscribe to personal DM alerts',
        '• <code>/stop</code> — Pause personal DM alerts',
        '• <code>/latest</code> — Get the full card &amp; alert for the latest launch',
        '• <code>/status</code> — Check bot status, graduation tracker &amp; latest launch',
        '• <code>/help</code> — Show this help message',
      ].join('\n');
      await this.bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
    };

    this.bot.command('status', (ctx) => replyStatus(ctx.chat.id).catch((e) => logger.warn(`/status err: ${errorMessage(e)}`)));
    this.bot.command('latest', (ctx) => replyLatest(ctx.chat.id).catch((e) => logger.warn(`/latest err: ${errorMessage(e)}`)));
    this.bot.command('help', (ctx) => replyHelp(ctx.chat.id).catch((e) => logger.warn(`/help err: ${errorMessage(e)}`)));

    // Also support /status, /latest, /help posted directly inside a channel where the bot is admin.
    this.bot.on('channel_post', (ctx) => {
      const post = ctx.channelPost;
      if (!('text' in post) || !post.text.startsWith('/')) return;
      const cmd = post.text.split(/\s+/)[0].split('@')[0].toLowerCase();
      if (cmd === '/status') void replyStatus(post.chat.id).catch((e) => logger.warn(`channel /status err: ${errorMessage(e)}`));
      else if (cmd === '/latest') void replyLatest(post.chat.id).catch((e) => logger.warn(`channel /latest err: ${errorMessage(e)}`));
      else if (cmd === '/help') void replyHelp(post.chat.id).catch((e) => logger.warn(`channel /help err: ${errorMessage(e)}`));
    });

    await this.bot.telegram
      .setMyCommands([
        { command: 'filters', description: 'Show your current personal filter settings' },
        { command: 'setminmc', description: 'Set minimum starting market cap in ETH (e.g. /setminmc 1.5)' },
        { command: 'setmaxtax', description: 'Set maximum buy tax % (e.g. /setmaxtax 3)' },
        { command: 'antisnipe', description: 'Toggle requiring anti-snipe protection (on/off)' },
        { command: 'setmindevbuy', description: 'Set minimum creator dev buy in ETH' },
        { command: 'graduated', description: 'Enable or disable graduated (~10x Launch Complete) alerts (on/off)' },
        { command: 'setminx', description: 'Set minimum multiple for graduated alerts (e.g. /setminx 10)' },
        { command: 'resetfilters', description: 'Reset your filters to default (receive everything)' },
        { command: 'latest', description: 'Send card & alert for the most recent launch' },
        { command: 'status', description: 'Show bot status, last block & latest launch' },
        { command: 'help', description: 'Show available bot commands' },
      ])
      .catch((err) => logger.warn(`Could not register bot command menu: ${errorMessage(err)}`));

    this.commandsLaunched = true;
    const launchPollingWithRetry = () => {
      if (!this.commandsLaunched) return;
      void this.bot
        .launch({ dropPendingUpdates: true })
        .catch((err) => {
          if (!this.commandsLaunched) return;
          logger.warn(
            `Telegram command listener interrupted (${errorMessage(err)}); reconnecting in 5s...`,
          );
          const timer = setTimeout(launchPollingWithRetry, 5_000);
          timer.unref?.();
        });
    };
    launchPollingWithRetry();
    logger.info(
      'Telegram bot commands enabled (/setminmc, /setmaxtax, /antisnipe, /setmindevbuy, /graduated, /setminx, /filters, /resetfilters, /status, /latest, /help)',
    );
  }

  stopCommandListener(signal = 'SIGTERM'): void {
    if (!this.commandsLaunched) return;
    this.commandsLaunched = false;
    try {
      this.bot.stop(signal);
    } catch {
      // Ignore if Telegraf was not actively polling.
    }
  }

  /** Executes a Telegram API call with throttling and 429 retry_after handling. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const wait = this.lastPostAt + MIN_POST_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);

      try {
        const result = await fn();
        this.lastPostAt = Date.now();
        return result;
      } catch (err) {
        this.lastPostAt = Date.now();
        const isTelegram = err instanceof TelegramError;

        // Client errors other than rate limiting (bad chat id, no rights,
        // malformed HTML...) won't fix themselves by retrying.
        if (isTelegram && err.code >= 400 && err.code < 500 && err.code !== 429) {
          throw err;
        }
        if (attempt >= MAX_ATTEMPTS) throw err;

        const retryAfterSec = isTelegram ? err.response.parameters?.retry_after : undefined;
        const delay = retryAfterSec ? retryAfterSec * 1000 : 1000 * 2 ** attempt;
        logger.warn(
          `Telegram send failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${errorMessage(err)}. Retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }
  }
}
