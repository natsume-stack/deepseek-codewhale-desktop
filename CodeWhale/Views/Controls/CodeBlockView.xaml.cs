using System;
using System.Collections.Generic;
using System.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;
using Windows.UI;

namespace CodeWhale.Views.Controls;

/// <summary>
/// 代码块展示控件。内置轻量级语法高亮（不依赖外部库），
/// 支持常见语言的关键字、字符串、注释、数字着色。
/// 支持文件名标题栏、行号列。
/// </summary>
public sealed partial class CodeBlockView : UserControl
{
    public static readonly DependencyProperty CodeProperty =
        DependencyProperty.Register(nameof(Code), typeof(string), typeof(CodeBlockView),
            new PropertyMetadata(string.Empty, OnCodeChanged));

    public static readonly DependencyProperty LanguageProperty =
        DependencyProperty.Register(nameof(Language), typeof(string), typeof(CodeBlockView),
            new PropertyMetadata("text", OnCodeChanged));

    public static readonly DependencyProperty FilePathProperty =
        DependencyProperty.Register(nameof(FilePath), typeof(string), typeof(CodeBlockView),
            new PropertyMetadata(string.Empty, OnFilePathChanged));

    /// <summary>代码文本。</summary>
    public string Code
    {
        get => (string)GetValue(CodeProperty);
        set => SetValue(CodeProperty, value);
    }

    /// <summary>语言标识（csharp/python/js/ts/json/sql 等）。</summary>
    public string Language
    {
        get => (string)GetValue(LanguageProperty);
        set => SetValue(LanguageProperty, value);
    }

    /// <summary>文件名（可选，显示在标题栏）。</summary>
    public string FilePath
    {
        get => (string)GetValue(FilePathProperty);
        set => SetValue(FilePathProperty, value);
    }

    public CodeBlockView()
    {
        InitializeComponent();
    }

    private static void OnCodeChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
        => ((CodeBlockView)d).Render();

    private static void OnFilePathChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
        => ((CodeBlockView)d).UpdateFilePath();

    private void UpdateFilePath()
    {
        FilePathText.Text = string.IsNullOrEmpty(FilePath) ? string.Empty : FilePath;
    }

    private void Render()
    {
        LanguageTag.Text = string.IsNullOrWhiteSpace(Language) ? "text" : Language.ToLowerInvariant();
        CodeLinesPanel.Children.Clear();
        LineNumbersPanel.Children.Clear();

        var code = Code ?? string.Empty;
        if (code.Length == 0) return;

        var language = (Language ?? "text").ToLowerInvariant();

        // 按行拆分：保留空行；行号列同步生成
        var lines = code.Split('\n');
        for (int i = 0; i < lines.Length; i++)
        {
            var line = lines[i].TrimEnd('\r');
            CodeLinesPanel.Children.Add(BuildCodeLine(line, language));
            LineNumbersPanel.Children.Add(BuildLineNumber(i + 1));
        }
    }

    /// <summary>构建一行代码文本（含语法高亮）。</summary>
    private TextBlock BuildCodeLine(string line, string language)
    {
        var tb = new TextBlock
        {
            FontFamily = new FontFamily("Cascadia Code, Consolas, Courier New"),
            FontSize = 13,
            LineHeight = 20,
            TextWrapping = TextWrapping.NoWrap,
            Foreground = (Brush)Application.Current.Resources["AppTextPrimaryBrush"]
        };

        foreach (var token in CodeHighlighter.Tokenize(line, language))
        {
            tb.Inlines.Add(new Run
            {
                Text = token.Text,
                Foreground = CodeHighlighter.GetBrush(token.Type)
            });
        }

        // 空行也需要占位高度
        if (tb.Inlines.Count == 0)
        {
            tb.Inlines.Add(new Run { Text = " " });
        }

        return tb;
    }

    /// <summary>构建行号文本。</summary>
    private TextBlock BuildLineNumber(int number)
    {
        return new TextBlock
        {
            Text = number.ToString(),
            FontFamily = new FontFamily("Cascadia Code, Consolas"),
            FontSize = 12,
            LineHeight = 20,
            Foreground = (Brush)Application.Current.Resources["AppTextTertiaryBrush"],
            Padding = new Thickness(0, 0, 8, 0),
            HorizontalAlignment = HorizontalAlignment.Right,
            TextAlignment = TextAlignment.Right
        };
    }

    private void CopyButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var package = new DataPackage();
            package.SetText(Code ?? string.Empty);
            Clipboard.SetContent(package);
        }
        catch
        {
            // 剪贴板在部分上下文下不可用，忽略。
        }
    }
}

/// <summary>
/// 轻量级代码高亮器。单遍扫描，支持行注释/块注释/字符串/数字/关键字。
/// </summary>
internal static class CodeHighlighter
{
    private static readonly Dictionary<string, HashSet<string>> Keywords = BuildKeywords();

    private static Dictionary<string, HashSet<string>> BuildKeywords()
    {
        var map = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);

        string[] csharp =
        {
            "public","private","protected","internal","class","struct","interface","enum","void","int","long",
            "short","byte","bool","string","double","float","decimal","char","object","var","new","return","if",
            "else","for","foreach","while","do","switch","case","break","continue","using","namespace","static",
            "readonly","const","null","true","false","async","await","Task","this","base","try","catch","finally",
            "throw","get","set","in","out","ref","override","virtual","abstract","sealed","partial","yield","is","as"
        };
        string[] jsTs =
        {
            "function","class","const","let","var","if","else","for","while","do","switch","case","break","continue",
            "return","import","from","export","default","new","null","undefined","true","false","async","await",
            "typeof","instanceof","this","super","try","catch","finally","throw","of","in","void","delete","yield",
            "interface","type","enum","extends","implements","readonly","public","private","protected","static","get","set"
        };
        string[] python =
        {
            "def","class","if","elif","else","for","while","return","import","from","as","None","True","False","and",
            "or","not","in","is","with","try","except","finally","raise","lambda","pass","break","continue","global",
            "nonlocal","yield","assert","del","self","async","await"
        };
        string[] json = { "true", "false", "null" };
        string[] sql =
        {
            "SELECT","FROM","WHERE","INSERT","INTO","VALUES","UPDATE","SET","DELETE","CREATE","TABLE","ALTER","DROP",
            "JOIN","LEFT","RIGHT","INNER","OUTER","ON","AND","OR","NOT","NULL","GROUP","BY","ORDER","HAVING","LIMIT",
            "OFFSET","AS","DISTINCT","UNION","ALL","PRIMARY","KEY","FOREIGN","REFERENCES","INDEX","VIEW","BEGIN","COMMIT","ROLLBACK"
        };

        foreach (var lang in new[] { "csharp", "cs", "c#", "java", "kotlin", "go", "rust", "cpp", "c" })
            map[lang] = new HashSet<string>(csharp, StringComparer.OrdinalIgnoreCase);
        foreach (var lang in new[] { "javascript", "js", "typescript", "ts", "jsx", "tsx" })
            map[lang] = new HashSet<string>(jsTs, StringComparer.OrdinalIgnoreCase);
        map["python"] = new HashSet<string>(python, StringComparer.OrdinalIgnoreCase);
        map["py"] = map["python"];
        map["json"] = new HashSet<string>(json, StringComparer.OrdinalIgnoreCase);
        map["sql"] = new HashSet<string>(sql, StringComparer.OrdinalIgnoreCase);

        return map;
    }

    public enum TokenType
    {
        Plain,
        Comment,
        String,
        Number,
        Keyword,
        Identifier,
        Punctuation
    }

    public readonly struct Token
    {
        public Token(TokenType type, string text) { Type = type; Text = text; }
        public TokenType Type { get; }
        public string Text { get; }
    }

    public static IEnumerable<Token> Tokenize(string code, string language)
    {
        var keywords = Keywords.TryGetValue(language, out var kw) ? kw : null;
        var lineComment = GetLineComment(language);
        var useBlockComment = UseBlockComment(language);
        var useTemplate = language is "javascript" or "js" or "typescript" or "ts" or "jsx" or "tsx";

        int i = 0;
        int n = code.Length;

        while (i < n)
        {
            char c = code[i];

            // 行注释
            if (lineComment != null && i + lineComment.Length <= n &&
                code.Substring(i, lineComment.Length) == lineComment)
            {
                int end = code.IndexOf('\n', i);
                if (end < 0) end = n;
                yield return new Token(TokenType.Comment, code.Substring(i, end - i));
                i = end;
                continue;
            }

            // 块注释 /* */
            if (useBlockComment && c == '/' && i + 1 < n && code[i + 1] == '*')
            {
                int end = code.IndexOf("*/", i + 2, StringComparison.Ordinal);
                if (end < 0) end = n; else end += 2;
                yield return new Token(TokenType.Comment, code.Substring(i, end - i));
                i = end;
                continue;
            }

            // 字符串 "..."  '...'  `...`
            if (c == '"' || c == '\'' || (useTemplate && c == '`'))
            {
                yield return new Token(TokenType.String, ReadString(code, ref i, n, c));
                continue;
            }

            // 数字
            if (char.IsDigit(c) || (c == '.' && i + 1 < n && char.IsDigit(code[i + 1])))
            {
                int start = i;
                while (i < n && (char.IsDigit(code[i]) || code[i] == '.' || code[i] == 'x' || code[i] == 'X'
                                 || (code[i] >= 'a' && code[i] <= 'f') || (code[i] >= 'A' && code[i] <= 'F')))
                {
                    i++;
                }
                yield return new Token(TokenType.Number, code.Substring(start, i - start));
                continue;
            }

            // 标识符 / 关键字
            if (char.IsLetter(c) || c == '_' || c == '$')
            {
                int start = i;
                while (i < n && (char.IsLetterOrDigit(code[i]) || code[i] == '_' || code[i] == '$'))
                    i++;
                string word = code.Substring(start, i - start);
                yield return new Token(
                    keywords != null && keywords.Contains(word) ? TokenType.Keyword : TokenType.Identifier,
                    word);
                continue;
            }

            // 标点（单字符）
            yield return new Token(TokenType.Punctuation, c.ToString());
            i++;
        }
    }

    private static string ReadString(string code, ref int i, int n, char quote)
    {
        int start = i;
        i++; // 跳过起始引号
        while (i < n)
        {
            if (code[i] == '\\' && i + 1 < n) { i += 2; continue; }
            if (code[i] == quote) { i++; break; }
            if (code[i] == '\n') break; // 跨行字符串此处不处理
            i++;
        }
        return code.Substring(start, i - start);
    }

    private static string? GetLineComment(string language) => language switch
    {
        "python" or "py" or "ruby" or "rb" or "shell" or "sh" or "bash" or "yaml" or "yml" or "toml" or "perl" or "r" => "#",
        "sql" or "lua" => "--",
        _ => "//"
    };

    private static bool UseBlockComment(string language) => language switch
    {
        "python" or "py" or "ruby" or "rb" or "shell" or "sh" or "bash" or "yaml" or "yml" or "toml" => false,
        _ => true
    };

    public static Brush GetBrush(TokenType type) => type switch
    {
        TokenType.Comment     => CommentBrush,
        TokenType.String      => StringBrush,
        TokenType.Number      => NumberBrush,
        TokenType.Keyword     => KeywordBrush,
        TokenType.Identifier  => IdentifierBrush,
        TokenType.Punctuation => PunctuationBrush,
        _                     => PlainBrush,
    };

    private static readonly Brush PlainBrush = MakeBrush("#D4D4D4");
    private static readonly Brush CommentBrush = MakeBrush("#6A9955");
    private static readonly Brush StringBrush = MakeBrush("#CE9178");
    private static readonly Brush NumberBrush = MakeBrush("#B5CEA8");
    private static readonly Brush KeywordBrush = MakeBrush("#569CD6");
    private static readonly Brush IdentifierBrush = MakeBrush("#9CDCFE");
    private static readonly Brush PunctuationBrush = MakeBrush("#D4D4D4");

    private static Brush MakeBrush(string hex)
    {
        var h = hex.StartsWith("#") ? hex.Substring(1) : hex;
        byte r = Convert.ToByte(h.Substring(0, 2), 16);
        byte g = Convert.ToByte(h.Substring(2, 2), 16);
        byte b = Convert.ToByte(h.Substring(4, 2), 16);
        byte a = h.Length >= 8 ? Convert.ToByte(h.Substring(6, 2), 16) : (byte)255;
        return new SolidColorBrush(Color.FromArgb(a, r, g, b));
    }
}
