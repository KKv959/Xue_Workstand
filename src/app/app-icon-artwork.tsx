type AppIconArtworkProps = {
  size: number;
};

export function AppIconArtwork({ size }: AppIconArtworkProps) {
  const markSize = Math.round(size * 0.56);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        background: "linear-gradient(145deg, #8dc8ff 0%, #8d9cff 25%, #c78df2 49%, #f3a2b4 69%, #f7cf8e 84%, #73d7cf 100%)"
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          background: "radial-gradient(circle at 22% 12%, rgba(255, 255, 255, 0.78) 0%, rgba(255, 255, 255, 0.18) 27%, rgba(255, 255, 255, 0) 48%)"
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: Math.round(size * 0.045),
          display: "flex",
          border: `${Math.max(2, Math.round(size * 0.012))}px solid rgba(255, 255, 255, 0.34)`,
          borderRadius: Math.round(size * 0.19),
          boxShadow: `inset 0 ${Math.max(2, Math.round(size * 0.012))}px ${Math.round(size * 0.045)}px rgba(255, 255, 255, 0.2)`
        }}
      />
      <svg
        aria-hidden="true"
        width={markSize}
        height={markSize}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{
          filter: `drop-shadow(0 ${Math.max(2, Math.round(size * 0.014))}px ${Math.max(2, Math.round(size * 0.024))}px rgba(50, 42, 102, 0.24))`
        }}
      >
        <path
          d="M45.5 14.5C47.4 27.8 54.7 35.1 68 37C54.7 38.9 47.4 46.2 45.5 59.5C43.6 46.2 36.3 38.9 23 37C36.3 35.1 43.6 27.8 45.5 14.5Z"
          fill="white"
        />
        <path
          d="M72 49C73.4 58.6 78.7 63.9 88.3 65.3C78.7 66.7 73.4 72 72 81.6C70.6 72 65.3 66.7 55.7 65.3C65.3 63.9 70.6 58.6 72 49Z"
          fill="white"
          fillOpacity="0.96"
        />
        <circle cx="24" cy="65" r="5.5" fill="white" fillOpacity="0.92" />
      </svg>
    </div>
  );
}
