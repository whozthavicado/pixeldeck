CXX ?= g++
CXXFLAGS ?= -O3 -std=c++17 -Wall -Wextra -pthread

mandelbrot: mandelbrot.cpp
	$(CXX) $(CXXFLAGS) -o $@ $<

clean:
	rm -f mandelbrot

.PHONY: clean
