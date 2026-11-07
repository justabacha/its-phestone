const settings = require('../core/settings');

const usage = [
  'Usage:',
  '!autoview',
  '!autoview on|off',
  '!autoview react on|off',
  '!autoview emojis <emoji1> <emoji2> ...'
].join('\n');

module.exports = {
  name: 'autoview',
  description: 'Configure automatic status viewing and reactions',
  async run(ctx) {
    const [action, option] = ctx.args;

    if (!action) {
      const autoView = settings.get('autoView') ? 'ON' : 'OFF';
      const autoReact = settings.get('autoReact') ? 'ON' : 'OFF';
      const emojis = settings.get('reactEmojis');
      await ctx.reply(`Auto-View: ${autoView}\nAuto-React: ${autoReact}\nEmojis: ${emojis.join(' ')}`);
      return;
    }

    const normalizedAction = action.toLowerCase();
    if (normalizedAction === 'on' && ctx.args.length === 1) {
      settings.set('autoView', true);
      await ctx.reply('✅ Auto-View enabled.');
      return;
    }

    if (normalizedAction === 'off' && ctx.args.length === 1) {
      settings.set('autoView', false);
      settings.set('autoReact', false);
      await ctx.reply('✅ Auto-View and Auto-React disabled.');
      return;
    }

    if (normalizedAction === 'react' && ctx.args.length === 2) {
      const reactAction = option.toLowerCase();
      if (reactAction === 'on') {
        if (!settings.get('autoView')) {
          await ctx.reply('⚠️ You must enable Auto-View first (!autoview on).');
          return;
        }

        settings.set('autoReact', true);
        await ctx.reply('✅ Auto-React enabled.');
        return;
      }

      if (reactAction === 'off') {
        settings.set('autoReact', false);
        await ctx.reply('✅ Auto-React disabled.');
        return;
      }
    }

    const emojiArgs = ctx.args.slice(1);
    if (normalizedAction === 'emojis' && emojiArgs.length > 0) {
      settings.set('reactEmojis', emojiArgs);
      await ctx.reply(`✅ Reaction emojis updated: ${emojiArgs.join(' ')}`);
      return;
    }

    await ctx.reply(usage);
  }
};
