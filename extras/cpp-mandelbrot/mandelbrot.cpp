// Multithreaded Mandelbrot set renderer for 24-bit-color terminals.
//
// Single frame:
//   ./mandelbrot
// Animated zoom (300 frames, zooming toward the seahorse valley):
//   ./mandelbrot --frames 300
//
// Run --help for all options.

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include <sys/ioctl.h>
#include <unistd.h>

struct Options {
    double centerX = -0.7453;
    double centerY = 0.1127;
    double scale = 2.5;        // half-height of the initial view, in complex-plane units
    double zoomFactor = 0.95;  // scale multiplier applied each frame (<1 zooms in)
    int frames = 1;
    int maxIterBase = 200;
    int frameDelayMs = 30;
};

static void getTerminalSize(int& cols, int& rows) {
    struct winsize ws {};
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws) == 0 && ws.ws_col > 0 && ws.ws_row > 1) {
        cols = ws.ws_col;
        rows = ws.ws_row - 1;  // leave the shell prompt's line alone
    } else {
        cols = 80;
        rows = 24;
    }
}

// Cubic-polynomial palette (Iñigo Quilez style): smooth, cheap, no branching per channel.
static void paletteColor(double t, int& r, int& g, int& b) {
    double u = 1.0 - t;
    r = static_cast<int>(9.0 * u * t * t * t * 255.0);
    g = static_cast<int>(15.0 * u * u * t * t * 255.0);
    b = static_cast<int>(8.5 * u * u * u * t * 255.0);
    r = std::clamp(r, 0, 255);
    g = std::clamp(g, 0, 255);
    b = std::clamp(b, 0, 255);
}

// Returns a fractional (smoothed) escape iteration count, or -1 for points inside the set.
static double escapeSmooth(double x0, double y0, int maxIter) {
    double x = 0, y = 0, x2 = 0, y2 = 0;
    int iter = 0;
    while (x2 + y2 <= 4.0 && iter < maxIter) {
        y = 2 * x * y + y0;
        x = x2 - y2 + x0;
        x2 = x * x;
        y2 = y * y;
        ++iter;
    }
    if (iter == maxIter) return -1.0;
    double logZn = std::log(x2 + y2) / 2.0;
    double nu = std::log(logZn / std::log(2.0)) / std::log(2.0);
    return iter + 1 - nu;
}

static void renderFrame(const Options& opt, int cols, int rows, double scale, std::string& out) {
    // Deeper zooms need more iterations to keep detail from washing out.
    int maxIter = opt.maxIterBase + static_cast<int>(std::log(opt.scale / scale + 1.0) * 150.0);

    // Terminal cells are roughly twice as tall as wide, so squash the x half-width.
    double halfHeight = scale;
    double halfWidth = scale * cols / rows * 0.5;

    std::vector<std::string> rowBuf(rows);
    unsigned nThreads = std::max(1u, std::thread::hardware_concurrency());
    std::vector<std::thread> pool;
    pool.reserve(nThreads);

    for (unsigned t = 0; t < nThreads; ++t) {
        pool.emplace_back([&, t]() {
            for (int py = static_cast<int>(t); py < rows; py += static_cast<int>(nThreads)) {
                double y0 = opt.centerY + (0.5 - static_cast<double>(py) / rows) * 2 * halfHeight;
                std::string line;
                line.reserve(static_cast<size_t>(cols) * 20);
                int lastR = -1, lastG = -1, lastB = -1;
                for (int px = 0; px < cols; ++px) {
                    double x0 = opt.centerX + (static_cast<double>(px) / cols - 0.5) * 2 * halfWidth;
                    double smooth = escapeSmooth(x0, y0, maxIter);
                    int r, g, b;
                    if (smooth < 0) {
                        r = g = b = 0;
                    } else {
                        paletteColor(std::fmod(smooth * 0.02, 1.0), r, g, b);
                    }
                    if (r != lastR || g != lastG || b != lastB) {
                        line += "\x1b[38;2;" + std::to_string(r) + ";" + std::to_string(g) + ";" +
                                std::to_string(b) + "m";
                        lastR = r;
                        lastG = g;
                        lastB = b;
                    }
                    line += "\xe2\x96\x88";  // UTF-8 for U+2588 FULL BLOCK
                }
                line += "\x1b[0m";
                rowBuf[py] = std::move(line);
            }
        });
    }
    for (auto& th : pool) th.join();

    out.clear();
    for (auto& l : rowBuf) {
        out += l;
        out += '\n';
    }
}

static void printHelp() {
    std::printf(
        "mandelbrot [options]\n"
        "  --frames N    number of frames to render; >1 animates a zoom (default 1)\n"
        "  --cx X        real part of the zoom target (default -0.7453)\n"
        "  --cy Y        imaginary part of the zoom target (default 0.1127)\n"
        "  --scale S     half-height of the initial view (default 2.5)\n"
        "  --zoom F      per-frame scale multiplier, <1 zooms in (default 0.95)\n"
        "  --delay MS    delay between frames in milliseconds (default 30)\n"
        "  --iter N      base max-iteration count (default 200)\n");
}

int main(int argc, char** argv) {
    Options opt;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&](double def) { return (i + 1 < argc) ? std::atof(argv[++i]) : def; };
        if (a == "--frames") opt.frames = static_cast<int>(next(opt.frames));
        else if (a == "--cx") opt.centerX = next(opt.centerX);
        else if (a == "--cy") opt.centerY = next(opt.centerY);
        else if (a == "--scale") opt.scale = next(opt.scale);
        else if (a == "--zoom") opt.zoomFactor = next(opt.zoomFactor);
        else if (a == "--delay") opt.frameDelayMs = static_cast<int>(next(opt.frameDelayMs));
        else if (a == "--iter") opt.maxIterBase = static_cast<int>(next(opt.maxIterBase));
        else if (a == "-h" || a == "--help") {
            printHelp();
            return 0;
        }
    }

    int cols, rows;
    getTerminalSize(cols, rows);

    bool animating = opt.frames > 1;
    if (animating) std::printf("\x1b[?25l\x1b[2J");  // hide cursor, clear screen

    double scale = opt.scale;
    std::string frame;
    for (int f = 0; f < opt.frames; ++f) {
        renderFrame(opt, cols, rows, scale, frame);
        if (animating) std::printf("\x1b[H");  // cursor home, avoids full-screen flicker
        std::fwrite(frame.data(), 1, frame.size(), stdout);
        std::fflush(stdout);
        if (f + 1 < opt.frames) {
            std::this_thread::sleep_for(std::chrono::milliseconds(opt.frameDelayMs));
            scale *= opt.zoomFactor;
        }
    }

    if (animating) std::printf("\x1b[?25h");  // restore cursor
    return 0;
}
