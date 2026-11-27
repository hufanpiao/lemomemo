// tests/build/gen-tauri-key.test.ts 用的假签名工具（编成 cargo-tauri.exe，只在临时目录里）：
// 模仿 tauri signer generate 不带 --write-keys 时往标准输出打印的格式，但给的是固定花纹的假字节，**不是能用的密钥**，不做任何加密运算。
// 环境变量：FAKE_SIGNER_MODE = ok（默认）
//             / empty（空密码：和真的 tauri-cli 一样，标准输出打印一行 <empty>，私钥盒标记仍是 EdScB2）
//             / plain（兼容工具兜底：私钥盒 KDF 标记是两个 0、没有 <empty> 那一行；tauri-cli 不会这样输出）
//             / badid（公钥说明行里的 key id 和公钥本身对不上）/ garbage（输出格式不对）/ fail（退出码 3）；
//           FAKE_SIGNER_LOG = 记下收到的参数、工作目录、收到的全部环境变量名（只记名字，JSON 一行）。
using System;
using System.IO;
using System.Text;

public static class FakeSigner {
    static string B64(byte[] b) { return Convert.ToBase64String(b); }
    static string Box(string comment, byte[] bin) {
        return B64(Encoding.UTF8.GetBytes("untrusted comment: " + comment + "\n" + B64(bin) + "\n"));
    }

    public static int Main(string[] args) {
        string mode = Environment.GetEnvironmentVariable("FAKE_SIGNER_MODE") ?? "ok";
        string log = Environment.GetEnvironmentVariable("FAKE_SIGNER_LOG");
        if (!string.IsNullOrEmpty(log)) {
            var sb = new StringBuilder("{\"args\":[");
            for (int i = 0; i < args.Length; i++) { if (i > 0) sb.Append(','); sb.Append('"').Append(args[i].Replace("\\", "\\\\").Replace("\"", "\\\"")).Append('"'); }
            sb.Append("],\"cwd\":\"").Append(Environment.CurrentDirectory.Replace("\\", "\\\\").Replace("\"", "\\\"")).Append("\",\"env\":[");
            bool first = true;
            foreach (string n in Environment.GetEnvironmentVariables().Keys) {
                if (!first) sb.Append(','); sb.Append('"').Append(n.Replace("\\", "\\\\").Replace("\"", "\\\"")).Append('"'); first = false;
            }
            sb.Append("]}");
            File.WriteAllText(log, sb.ToString());
        }
        if (mode == "fail") {
            Console.Error.WriteLine("error: failed to generate key pair QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w");
            return 3;
        }
        if (mode == "garbage") {
            Console.WriteLine("Your keys were generated successfully!");
            Console.WriteLine("something else");
            return 0;
        }
        // 私钥盒 158 字节：Ed + Sc（加密）或两个 0（没加密）+ B2，其余是固定花纹 0x5A
        byte[] sk = new byte[158];
        for (int i = 0; i < sk.Length; i++) sk[i] = 0x5A;
        sk[0] = (byte)'E'; sk[1] = (byte)'d';
        if (mode == "plain") { sk[2] = 0; sk[3] = 0; } else { sk[2] = (byte)'S'; sk[3] = (byte)'c'; }
        sk[4] = (byte)'B'; sk[5] = (byte)'2';
        // 公钥盒 42 字节：Ed + key id 01..08 + 32 字节 0x33
        byte[] pk = new byte[42];
        pk[0] = (byte)'E'; pk[1] = (byte)'d';
        for (int i = 0; i < 8; i++) pk[2 + i] = (byte)(i + 1);
        for (int i = 10; i < 42; i++) pk[i] = 0x33;
        Console.WriteLine("Please enter a password to protect the secret key.");
        if (mode == "empty") Console.WriteLine("<empty>");
        Console.WriteLine("Deriving a key from the password in order to encrypt the secret key... done");
        Console.WriteLine();
        Console.WriteLine("Your keys were generated successfully!");
        Console.WriteLine();
        Console.WriteLine("Private: (Keep it secret!)");
        Console.WriteLine(Box("rsign encrypted secret key", sk));
        Console.WriteLine();
        Console.WriteLine("Public:");
        Console.WriteLine(Box(mode == "badid" ? "minisign public key: 0102030405060708" : "minisign public key: 0807060504030201", pk));
        Console.WriteLine("---------------------------");
        Console.WriteLine();
        Console.WriteLine("Environment variables used to sign:");
        Console.WriteLine("`TAURI_SIGNING_PRIVATE_KEY`  Path or String of your private key");
        Console.WriteLine("`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`  Your private key password (optional)");
        Console.WriteLine();
        Console.WriteLine("ATTENTION: If you lose your private key OR password, you'll not be able to sign your update package and updates will not work.");
        return 0;
    }
}
