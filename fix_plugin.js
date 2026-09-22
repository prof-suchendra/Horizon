const fs = require('fs');
let code = fs.readFileSync('android/app/src/main/java/com/atomiqindia/horizon/YoutubeDlPlugin.java', 'utf8');

// 1. Remove ffmpeg import
code = code.replace('import com.yausername.ffmpeg_android.FFmpeg;', '');

// 2. Remove ffmpeg init
code = code.replace('            FFmpeg.getInstance().init(getContext());', '');

// 3. Fix double PluginMethod
code = code.replace('@PluginMethod\n    @PluginMethod', '@PluginMethod');

// 4. Fix UpdateChannel
code = code.replace('YoutubeDL.getInstance().updateYoutubeDL(getContext(), YoutubeDL.UpdateChannel.NIGHTLY);', 'YoutubeDL.getInstance().updateYoutubeDL(getContext());');

fs.writeFileSync('android/app/src/main/java/com/atomiqindia/horizon/YoutubeDlPlugin.java', code);
console.log("Plugin fixed!");
