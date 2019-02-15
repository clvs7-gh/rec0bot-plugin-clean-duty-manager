import { Logger } from '@log4js-node/log4js-api';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { BotProxy } from '../../src/interface/bot-proxy.interface';

let mBot: BotProxy;
let logger: Logger;
let metadata: { [key: string]: string };

interface User {
    username: string;
    fullname: string;
    isDone: boolean;
}

let users: User[] = [];
let currentUser: User;

const BRIDGE_PLUGIN_NAME = 'ldap-bridge';
const BRIDGE_REQUEST_EVENT_NAME = 'sync-request';
const DATA_DIR_NAME = 'data';
const USERS_JSON_FILENAME = 'users.json';
const NOTIFY_DEFAULT_CHANNEL_NAME = (process.env.REC0_ENV_CLEAN_NOTIFY_CHANNEL || '').trim() || 'general';

/**
 * Internal functions
 */

const logCurrentUserStat = () => {
    logger.info(`Users count : ${users.length}, current : ${currentUser ? currentUser.username : '(None)'}`);
};

const isUserSynced = (): boolean => {
    return users.length > 0 && !!currentUser;
};

const selectNext = async (selectFn?: () => User | undefined): Promise<boolean> => {
    selectFn = selectFn || (() => {
        const remaining = users.filter((u) => !u.isDone);
        if (remaining.length <= 0) {
            users.forEach((u) => u.isDone = false);
            logger.info('State has been re-set!');
        }
        // Fisher-Yates algorithm
        for ( let i = (remaining.length - 1); i > 0; --i ) {
            const rand = Math.floor(Math.random() * (i + 1));
            [remaining[i], remaining[rand]] = [remaining[rand], remaining[i]];
        }
        return remaining[0];
    });
    const selected = selectFn();
    // Ensure (prevent error)
    if (!selected) {
        logger.warn('Failed to select next user!');
        return false;
    }
    currentUser = selected;
    logger.info(`Selected : ${currentUser.username}`);
    return true;
};

const saveState = async () => {
    // Save
    await promisify(fs.writeFile)(path.resolve(__dirname, DATA_DIR_NAME, USERS_JSON_FILENAME), JSON.stringify({
        users: users, current: currentUser
    }), {
        encoding: 'utf-8',
        flag: 'w'
    });
};

const loadState = async () => {
    // Open or create file
    let raw = await promisify(fs.readFile)(path.resolve(__dirname, DATA_DIR_NAME, USERS_JSON_FILENAME), {
        encoding: 'utf-8',
        flag: 'a+'
    });
    let isSave = raw.trim().length <= 0;
    raw = raw || JSON.stringify({users: [], current: null});
    const parsed = JSON.parse(raw);
    users = parsed.users;
    if (parsed.current) {
        currentUser = parsed.current;
    } else if (users.length > 0) {
        isSave = await selectNext() || isSave;
    }
    if (isSave) {
        await saveState();
    }
};

const markDone = (isDone: boolean) => {
    currentUser.isDone = isDone;
    const user = users.find((u) => u.username === currentUser.username);
    if (user) {
        user.isDone = isDone;
    }
};

const sendList = async (channelId: string) => {
    let talkString = `*Current : ${currentUser.fullname} (${currentUser.username})*\n\n`;
    talkString += `${'-'.repeat(30)}\n\n`;
    talkString += users.map((u) => {
        return `${u.fullname} (${u.username}): ${u.isDone ? 'done!' : 'not yet'}`;
    }).join('\n');
    await mBot.sendTalk(channelId, talkString);
};

const notify = async (channelId: string, isNew: boolean) => {
    if (isNew) {
        await mBot.sendTalk(channelId, `おめでとうございます。幸福な部員、 ${currentUser.fullname} さんが今週の掃除当番に選ばれました！`);
    } else {
        await mBot.sendTalk(channelId, `${currentUser.fullname} さん、今週の掃除がまだ終わっていません。\n`
            + '幸福と清掃は部員の義務です。 *部員、あなたは幸福ですか？* \n'
            + '掃除が完了したら、 `@c0debot 掃除完了` 又は `@c0debot clean fin` と入力してください。\n'
            + 'また、反逆者を見つけた場合は直ちに `@c0debot clean zap 反逆者名` と入力して報告してください。');
    }
};

const _finish = async () => {
    markDone(true);
    try {
        await saveState();
    } catch (e) {
        throw new Error(`Could not save state! error : ${e}`);
    }
};

const finish = async (channelId: string) => {
    if (currentUser.isDone) {
        await mBot.sendTalk(channelId, '今週の清掃は既に完了しています。ああ、なんと素晴らしい！');
    } else {
        await _finish();
        await mBot.sendTalk(channelId, `完璧で幸福な部員である ${currentUser.fullname} さん、清掃お疲れ様でした。今後の活躍にも期待しています！`);
    }
};

const _skip = async (isMarkDone: boolean) => {
    if (isMarkDone) {
        await _finish();
    }
    await selectNext();
};

const skip = async (channelId: string, isMarkDone = true) => {
    await mBot.sendTalk(channelId,
        `コンピューター様のご厚意により、優秀で幸福な部員、 ${currentUser.fullname} さんの掃除当番は${isMarkDone ? '免除' : '延期'}されました！\n`
        + `これより再抽選を行います。しばらくお待ちください……`);
    await _skip(isMarkDone);
    // Wait some seconds...
    await new Promise((r) => setTimeout(r, 5000));
    // Notify for changed one!
    await notify(channelId, true);
};

const change = async (channelId: string, name: string) => {
    const result = await selectNext(() => users.find((u) => u.username === name || u.fullname === name));
    if (!result) {
        await mBot.sendTalk(channelId, '部員、それは無効な選択です。変更に失敗しました。');
        return;
    }
    await mBot.sendTalk(channelId, `コンピューター様のご厚意により、掃除当番は ${currentUser.fullname} さんに変更されました。働きに期待しています！`);
};

const zap = async (channelId: string, name: string) => {
    await _finish();
    const result = await selectNext(() => users.find((u) => u.username === name || u.fullname === name));
    if (!result) {
        await mBot.sendTalk(channelId, '部員、それは無効な選択です。変更に失敗しました。');
        return;
    }
    await mBot.sendTalk(channelId, '*ZAPZAPZAP!!* \n\n'
        + `反逆者になった ${currentUser.fullname} は粛清され、代わりにクローンが届きました。\n`
        + `新しい ${currentUser.fullname} さんは以前の薄汚い反逆者ではなく、完璧で幸福な部員に違いありません。\n`
        + `掃除当番は ${currentUser.fullname} さんに設定されました。働きに期待しています！`);
};

const handleSubCommand = async (cmds: string[], channelId: string, userId: string, data: { [key: string]: any }) => {
    switch (cmds[0]) {
        case 'who':
            await mBot.sendTalk(channelId, `今週の幸福な当番は ${currentUser.fullname} さんです！`);
            break;
        case 'change':
            await change(await mBot.getChannelId(NOTIFY_DEFAULT_CHANNEL_NAME), cmds[1] || '');
            break;
        case 'zap':
            await zap(await mBot.getChannelId(NOTIFY_DEFAULT_CHANNEL_NAME), cmds[1] || '');
            break;
        case 'postpone':
            await skip(await mBot.getChannelId(NOTIFY_DEFAULT_CHANNEL_NAME), false);
            break;
        case 'skip':
            await skip(await mBot.getChannelId(NOTIFY_DEFAULT_CHANNEL_NAME));
            break;
        case 'list':
            await sendList(channelId);
            break;
        case 'fin':
            await finish(await mBot.getChannelId(NOTIFY_DEFAULT_CHANNEL_NAME));
            break;
    }
};

/**
 * Exported functions
 */

export const init = async (bot: BotProxy, options: { [key: string]: any }): Promise<void> => {
    mBot = bot;
    logger = options.logger || console;
    metadata = await import(path.resolve(__dirname, 'package.json'));

    await loadState();
    logCurrentUserStat();

    logger.info(`${metadata.name} plugin v${metadata.version} has been initialized.`);
};

export const onStart = async () => {
    logger.debug('onStart()');
    await mBot.firePluginEvent(BRIDGE_PLUGIN_NAME, BRIDGE_REQUEST_EVENT_NAME).catch(() => {
        // Nop
    });
};

export const onStop = async () => {
    logger.debug('onStop()');
    await saveState();
};

export const onMessage = async (message: string, channelId: string, userId: string, data: { [key: string]: any }) => {
    if (!isUserSynced()) {
        await mBot.sendTalk(channelId, 'ユーザー同期の待機中です。しばらくお待ちください。');
        return;
    }
    const cmds = message.split(' ').map((m) => m.trim());
    switch (cmds[0]) {
        case '掃除完了':
            await finish(channelId);
            break;
        case 'clean':
            if (cmds.length > 1) {
                await handleSubCommand(cmds.slice(1), channelId, userId, data);
            }
            break;
    }
};

export const onPluginEvent = async (eventName: string, value?: any, fromId?: string) => {
    switch (eventName) {
        case 'sync-user':
            if (value && Array.isArray(value) && value.length > 0) {
                logger.info('Sync-user has been succeeded.');
                logger.debug('New users: ', value);
                users = value.map((entry) => {
                    entry['isDone'] = users[entry.username] ? users[entry.username].isDone : false;
                    return entry;
                });
                if (!currentUser && await selectNext()) {
                    await notify(await mBot.getChannelId(NOTIFY_DEFAULT_CHANNEL_NAME), true);
                }
                await saveState();
            } else {
                logger.warn('Received empty users info!');
            }
            break;
        case 'scheduled:notify':
            if (!isUserSynced()) {
                return;
            }
            await notify(await mBot.getChannelId(NOTIFY_DEFAULT_CHANNEL_NAME), false);
            break;
        case 'scheduled:select':
            if (!isUserSynced()) {
                return;
            }
            if (await selectNext()) {
                await saveState();
                await notify(await mBot.getChannelId(NOTIFY_DEFAULT_CHANNEL_NAME), true);
            }
            break;
    }
};
