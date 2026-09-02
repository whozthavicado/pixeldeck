# mandelbrot

A multithreaded Mandelbrot set renderer for 24-bit-color terminals. Standalone,
zero dependencies beyond the C++17 standard library and POSIX (`ioctl`,
`unistd.h`).

## Build

```
make
```

## Run

```
./mandelbrot                  # single frame, sized to the terminal
./mandelbrot --frames 300     # animated zoom into the seahorse valley
./mandelbrot --help           # all options
```

Rendering is split across `std::thread::hardware_concurrency()` worker
threads, one per scanline stripe. Escape-time iteration counts are smoothed
(fractional) and mapped through a continuous cosine-style palette, so color
bands don't show even under a deep zoom. Iteration count scales up
automatically with zoom depth to keep detail sharp.
