const settings = require('../core/settings');

module.exports = {
  name: 'like',
  description: 'Toggle automatic status reactions and configure emojis',
  async run(ctx) {
    const [action, ...args] = ctx.args;

    if (!action) {
      const autoReact = settings.get('autoReact') ? 'ON' : 'OFF';
      const emojis = settings.get('reactEmojis');
      await ctx.reply(`❤️ Auto-like is currently ${autoReact}.\nEmojis: ${emojis.join(' ')}`);
      return;
    }

    if (action.toLowerCase() === 'on' && args.length === 0) {
      if (!settings.get('autoView')) {
        await ctx.reply('⚠️ You must turn on Auto-View first (!view on).');
        return;
      }

      settings.set('autoReact', true);
      await ctx.reply('❤️ Auto-like is now ON.');
      return;
    }

    if (action.toLowerCase() === 'off' && args.length === 0) {
      settings.set('autoReact', false);
      await ctx.reply('❤️ Auto-like is now OFF.');
      return;
    }

    if (['emoji', 'emojis'].includes(action.toLowerCase()) && args.length > 0) {
      const emojis = args.join(' ').split(',').map(emoji => emoji.trim()).filter(Boolean);
      settings.set('reactEmojis', emojis);
      await ctx.reply(`❤️ Auto-like emojis updated: ${emojis.join(' ')}`);
      return;
    }

    await ctx.reply('Usage: !like on|off|emojis 🥺,🥹,😂');
  }
};
