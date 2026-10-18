import React, { useEffect, useState } from 'react';

export interface SmoothImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
}

export const SmoothImage: React.FC<SmoothImageProps> = ({ src, className, ...props }) => {
  const [displaySrc, setDisplaySrc] = useState(src);
  const [nextSrc, setNextSrc] = useState<string | null>(null);
  const [nextLoaded, setNextLoaded] = useState(false);

  useEffect(() => {
    if (src !== displaySrc) {
      setNextSrc(src);
      setNextLoaded(false);
    }
  }, [src, displaySrc]);

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {/* 底层常驻图：保证白底永远不会漏出来 */}
      {displaySrc && (
        <img
          src={displaySrc}
          className="w-full h-full object-cover absolute inset-0"
          alt="thumb-base"
        />
      )}
      
      {/* 顶层新图：透明度渐入 */}
      {nextSrc && (
        <img
          src={nextSrc}
          className={`w-full h-full object-cover absolute inset-0 transition-opacity duration-300 ${
            nextLoaded ? 'opacity-100' : 'opacity-0'
          }`}
          onLoad={() => {
            setNextLoaded(true);
            // 等渐变动画结束后，把新图变成底层常驻图
            setTimeout(() => {
              setDisplaySrc(nextSrc);
              setNextSrc(null);
            }, 300);
          }}
          alt="thumb-new"
          {...props}
        />
      )}
    </div>
  );
};