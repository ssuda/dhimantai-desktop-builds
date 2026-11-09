// Shared programs for local-runner ↔ sandbox parity. `line` is the ground-truth learner line an error
// should map to (null: no learner line is expected, e.g. a segfault without diagnostics).
export interface ParityCase {
  name: string;
  source: string;
  argv?: string[];
  files?: { name: string; content: string }[];
  stdin?: string;
  line?: number | null;
  slow?: boolean;
}

const DATA = [{ name: 'data.txt', content: 'Hello తెలుగు world\nhello\n' }];
const ARGV = ['--mode=x', 'two words', 'data.txt'];
const STDIN = 'alpha\nతెలుగు\n';

export const CORPUS: Record<string, ParityCase[]> = {
  python: [
    { name: 'args+files', argv: ARGV, files: DATA, source: `import sys
for i, a in enumerate(sys.argv[1:]):
    print(i, a)
print('words', len(open(sys.argv[3], encoding='utf-8').read().split()))
` },
    { name: 'stdin', stdin: STDIN, source: `import sys
data = sys.stdin.read()
print('lines=' + str(len(data.splitlines())))
sys.stdout.write(data)
` },
    { name: 'exit+stderr', source: `import sys
print('out')
print('err', file=sys.stderr)
sys.exit(3)
` },
    { name: 'runtime error', line: 3, source: `values = [1, 2]
print('before')
print(values[5])
` },
    { name: 'timeout', slow: true, source: 'while True:\n    pass\n' },
  ],
  javascript: [
    { name: 'args+files', argv: ARGV, files: DATA, source: `const fs = require('fs');
const args = process.argv.slice(2);
args.forEach((a, i) => console.log(i + ' ' + a));
console.log('words ' + fs.readFileSync(args[2], 'utf8').split(/\\s+/).filter(Boolean).length);
` },
    { name: 'stdin', stdin: STDIN, source: `const data = require('fs').readFileSync(0, 'utf8');
console.log('lines=' + data.split('\\n').filter((l, i, a) => i < a.length - 1 || l).length);
process.stdout.write(data);
` },
    { name: 'exit+stderr', source: `console.log('out');
console.error('err');
process.exitCode = 3;
` },
    { name: 'runtime error', line: 3, source: `const values = null;
console.log('before');
console.log(values.length);
` },
  ],
  typescript: [
    { name: 'args+files', argv: ARGV, files: DATA, source: `import { readFileSync } from "node:fs";
const args: string[] = process.argv.slice(2);
args.forEach((a, i) => console.log(\`\${i} \${a}\`));
console.log(\`words \${readFileSync(args[2], "utf8").split(/\\s+/).filter(Boolean).length}\`);
` },
    { name: 'stdin', stdin: STDIN, source: `import { readFileSync } from "node:fs";
const data: string = readFileSync(0, "utf8");
console.log(\`lines=\${data.split("\\n").filter((l, i, a) => i < a.length - 1 || l).length}\`);
process.stdout.write(data);
` },
    { name: 'exit+stderr', source: `console.log("out");
console.error("err");
process.exitCode = 3;
` },
    // Runtime errors point into compiled main.js, which has no learner line in main.ts.
    { name: 'runtime error', line: null, source: `const values: number[] | null = JSON.parse("null");
console.log("before");
console.log(values!.length);
` },
    { name: 'compile error', line: 2, source: `const count: number = 1;
const label: string = count;
console.log(label);
` },
  ],
  c: [
    { name: 'args+files', argv: ARGV, files: DATA, source: `#include <stdio.h>
int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) printf("%d %s\\n", i - 1, argv[i]);
    FILE *f = fopen(argv[3], "r");
    int words = 0, in = 0, c;
    while ((c = fgetc(f)) != EOF) {
        int space = c == ' ' || c == '\\n' || c == '\\t';
        if (!space && !in) words++;
        in = !space;
    }
    printf("words %d\\n", words);
    return 0;
}
` },
    { name: 'stdin', stdin: STDIN, source: `#include <stdio.h>
int main(void) {
    char buf[4096];
    size_t n = fread(buf, 1, sizeof buf, stdin);
    int lines = 0;
    for (size_t i = 0; i < n; i++) if (buf[i] == '\\n') lines++;
    printf("lines=%d\\n", lines);
    fwrite(buf, 1, n, stdout);
    return 0;
}
` },
    { name: 'exit+stderr', source: `#include <stdio.h>
int main(void) {
    printf("out\\n");
    fprintf(stderr, "err\\n");
    return 3;
}
` },
    { name: 'segfault', line: null, source: `#include <stdio.h>
int main(void) {
    volatile int *p = NULL;
    printf("before\\n");
    fflush(stdout);
    return *p;
}
` },
    { name: 'compile error', line: 3, source: `#include <stdio.h>
int main(void) {
    printf("%d\\n", missing);
    return 0;
}
` },
  ],
  java: [
    { name: 'args+files', argv: ARGV, files: DATA, source: `import java.nio.file.*;
public class Main {
    public static void main(String[] args) throws Exception {
        for (int i = 0; i < args.length; i++) System.out.println(i + " " + args[i]);
        String text = Files.readString(Path.of(args[2]));
        System.out.println("words " + text.trim().split("\\\\s+").length);
    }
}
` },
    { name: 'stdin', stdin: STDIN, source: `import java.io.*;
public class Main {
    public static void main(String[] args) throws Exception {
        PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        String data = new String(System.in.readAllBytes(), "UTF-8");
        out.println("lines=" + data.lines().count());
        out.print(data);
    }
}
` },
    { name: 'exit+stderr', source: `public class Main {
    public static void main(String[] args) {
        System.out.println("out");
        System.err.println("err");
        System.exit(3);
    }
}
` },
    { name: 'runtime error', line: 5, source: `public class Main {
    public static void main(String[] args) {
        int[] values = new int[2];
        System.out.println("before");
        System.out.println(values[5]);
    }
}
` },
    { name: 'compile error', line: 3, source: `public class Main {
    public static void main(String[] args) {
        int x = "text";
        System.out.println(x);
    }
}
` },
  ],
  go: [
    { name: 'args+files', argv: ARGV, files: DATA, source: `package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	for i, a := range os.Args[1:] {
		fmt.Println(i, a)
	}
	data, _ := os.ReadFile(os.Args[3])
	fmt.Println("words", len(strings.Fields(string(data))))
}
` },
    { name: 'stdin', stdin: STDIN, source: `package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

func main() {
	data, _ := io.ReadAll(os.Stdin)
	fmt.Printf("lines=%d\\n", strings.Count(string(data), "\\n"))
	os.Stdout.Write(data)
}
` },
    { name: 'exit+stderr', source: `package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Println("out")
	fmt.Fprintln(os.Stderr, "err")
	os.Exit(3)
}
` },
    { name: 'runtime error', line: 8, source: `package main

import "fmt"

func main() {
	values := []int{1, 2}
	i := 5
	fmt.Println("before", values[i])
}
` },
    { name: 'compile error', line: 6, source: `package main

import "fmt"

func main() {
	fmt.Println(missing)
}
` },
  ],
  rust: [
    { name: 'args+files', argv: ARGV, files: DATA, source: `use std::env;
use std::fs;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    for (i, a) in args.iter().enumerate() {
        println!("{} {}", i, a);
    }
    let text = fs::read_to_string(&args[2]).unwrap();
    println!("words {}", text.split_whitespace().count());
}
` },
    { name: 'stdin', stdin: STDIN, source: `use std::io::{self, Read, Write};

fn main() {
    let mut data = String::new();
    io::stdin().read_to_string(&mut data).unwrap();
    println!("lines={}", data.lines().count());
    io::stdout().write_all(data.as_bytes()).unwrap();
}
` },
    { name: 'exit+stderr', source: `fn main() {
    println!("out");
    eprintln!("err");
    std::process::exit(3);
}
` },
    { name: 'runtime error', line: 4, source: `fn main() {
    let values = vec![1, 2];
    let i = values.len() + 3;
    println!("{}", values[i]);
}
` },
    { name: 'compile error', line: 3, source: `fn main() {
    let count: u32 = 1;
    let label: String = count;
    println!("{}", label);
}
` },
  ],
};
